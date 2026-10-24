import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert } from 'react-native'
import {
  terminalDraftBegin,
  terminalDraftRelease,
  terminalDraftSave,
  terminalDraftSubmit
} from '../terminal/mobile-terminal-operations'
import type { MobileSessionTerminalWebviewModel } from './use-mobile-session-terminal-webview'

export type MobileRemoteDraftSession = {
  handle: string
  epoch: number
  baseToken: string
  remoteText: string
}

export type MobileRemoteDraftConflict = {
  text: string
  sourceToken: string
}

export type MobileRemoteDraftSubmitOutcome =
  | { applied: true; status: 'submitted' | 'saved_not_submitted' | 'submit_unknown' }
  | { applied: false }

function operationId(): string {
  return `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Pulls the agent's real terminal draft into the local command field. Local typing never waits on
 * the host; only "load", "save" and "send" touch it. The host lease plus the adapter token are what
 * stop two devices from silently overwriting each other.
 */
export function useMobileSessionRemoteDraft(scope: MobileSessionTerminalWebviewModel) {
  const {
    client,
    connState,
    activeHandle,
    activeHandleRef,
    deviceTokenRef,
    bufferedTerminalDraftState,
    showToast
  } = scope
  const [session, setSession] = useState<MobileRemoteDraftSession | null>(null)
  const [conflict, setConflict] = useState<MobileRemoteDraftConflict | null>(null)
  const sessionRef = useRef<MobileRemoteDraftSession | null>(null)
  sessionRef.current = session

  const release = useCallback((target: MobileRemoteDraftSession | null) => {
    const rpc = client
    const deviceToken = deviceTokenRef.current
    if (!target || !rpc || !deviceToken) {
      return
    }
    void terminalDraftRelease
      .request(
        rpc,
        {
          terminal: target.handle,
          client: { id: deviceToken, type: 'mobile' },
          epoch: target.epoch
        },
        { failWhenDisconnected: true }
      )
      .catch(() => {})
  }, [])

  useEffect(() => {
    const previous = sessionRef.current
    if (previous && previous.handle !== activeHandle) {
      release(previous)
      setSession(null)
      setConflict(null)
    }
  }, [activeHandle, release])

  useEffect(() => () => release(sessionRef.current), [release])

  const begin = useCallback(
    async (force: boolean) => {
      const rpc = client
      const handle = activeHandle
      const deviceToken = deviceTokenRef.current
      if (!rpc || !handle || connState !== 'connected' || !deviceToken) {
        showToast('Connect to the host before loading its draft', 1800)
        return
      }
      const response = await terminalDraftBegin.request(
        rpc,
        {
          terminal: handle,
          client: { id: deviceToken, type: 'mobile' },
          ...(force ? { force: true } : {})
        },
        { failWhenDisconnected: true }
      )
      const result = terminalDraftBegin.interpret(response)
      if (!result) {
        showToast("This Orca host doesn't support draft editing yet", 2200)
        return
      }
      if (!result.ok) {
        if (result.reason === 'locked' && result.holder) {
          Alert.alert(
            'Draft is open elsewhere',
            `${result.holder.clientType} is editing this terminal draft.`,
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Take over', style: 'destructive', onPress: () => void begin(true) }
            ]
          )
          return
        }
        showToast(
          result.reason === 'no_bridge' || result.reason === 'unsupported_agent'
            ? 'This agent does not expose a readable draft'
            : 'Could not read the terminal draft',
          2200
        )
        return
      }
      if (
        handle !== activeHandleRef.current ||
        result.epoch === undefined ||
        typeof result.text !== 'string' ||
        typeof result.sourceToken !== 'string'
      ) {
        return
      }
      const next: MobileRemoteDraftSession = {
        handle,
        epoch: result.epoch,
        baseToken: result.sourceToken,
        remoteText: result.text
      }
      setSession(next)
      setConflict(null)
      bufferedTerminalDraftState.setInput(result.text)
      showToast('Loaded terminal draft', 1200)
    },
    [activeHandle, activeHandleRef, bufferedTerminalDraftState, client, connState, showToast]
  )

  const loadRemoteDraft = useCallback(() => {
    const local = bufferedTerminalDraftState.input
    const current = sessionRef.current
    if (current && local === current.remoteText) {
      void begin(false)
      return
    }
    if (local.trim().length === 0) {
      void begin(false)
      return
    }
    Alert.alert(
      'Replace local input?',
      'The terminal draft will replace what you typed here. This only changes the local field.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Load draft', onPress: () => void begin(false) }
      ]
    )
  }, [begin, bufferedTerminalDraftState.input])

  const saveRemoteDraft = useCallback(async () => {
    const current = sessionRef.current
    const rpc = client
    const deviceToken = deviceTokenRef.current
    if (!current || !rpc || !deviceToken) {
      showToast('Load the terminal draft first', 1600)
      return
    }
    const response = await terminalDraftSave.request(
      rpc,
      {
        terminal: current.handle,
        client: { id: deviceToken, type: 'mobile' },
        epoch: current.epoch,
        baseToken: current.baseToken,
        text: bufferedTerminalDraftState.input,
        operationId: operationId()
      },
      { failWhenDisconnected: true }
    )
    const result = terminalDraftSave.interpret(response)
    if (result?.ok) {
      const next = {
        ...current,
        baseToken: result.sourceToken ?? current.baseToken,
        remoteText: bufferedTerminalDraftState.input
      }
      setSession(next)
      showToast(result.replayed ? 'Already saved to terminal' : 'Saved to terminal', 1400)
      return
    }
    if (result?.status === 'conflict' && result.conflict) {
      setConflict(result.conflict)
      showToast('Terminal draft changed elsewhere', 2200)
      return
    }
    showToast(
      result?.status === 'unknown'
        ? 'Result unknown — check the terminal before retrying'
        : 'Could not save the draft',
      2400
    )
  }, [bufferedTerminalDraftState.input, client, showToast])

  const submitRemoteDraft = useCallback(
    async (text: string): Promise<MobileRemoteDraftSubmitOutcome> => {
      const current = sessionRef.current
      const rpc = client
      const deviceToken = deviceTokenRef.current
      if (!current || !rpc || !deviceToken) {
        return { applied: false }
      }
      const response = await terminalDraftSubmit.request(
        rpc,
        {
          terminal: current.handle,
          client: { id: deviceToken, type: 'mobile' },
          epoch: current.epoch,
          baseToken: current.baseToken,
          text,
          operationId: operationId()
        },
        { failWhenDisconnected: true }
      )
      const result = terminalDraftSubmit.interpret(response)
      if (!result) {
        showToast("This Orca host doesn't support draft editing yet", 2200)
        return { applied: false }
      }
      if (result.ok && result.status === 'submitted') {
        release(current)
        setSession(null)
        setConflict(null)
        showToast('Sent to the terminal', 1200)
        return { applied: true, status: 'submitted' }
      }
      if (result.ok && result.status === 'saved_not_submitted') {
        if (result.sourceToken) {
          setSession({ ...current, baseToken: result.sourceToken })
        }
        showToast('Saved, but Enter was refused. Check the terminal.', 2400)
        return { applied: true, status: 'saved_not_submitted' }
      }
      if (result.ok && result.status === 'submit_unknown') {
        // Why: an unknown Enter must not be retried by a second tap; drop the lease and leave it there.
        setSession(null)
        release(current)
        showToast('Result unknown — check the terminal before sending again', 2600)
        return { applied: true, status: 'submit_unknown' }
      }
      if (result.status === 'conflict' && result.conflict) {
        setConflict(result.conflict)
        showToast('Terminal draft changed elsewhere', 2200)
        return { applied: false }
      }
      showToast(
        result.status === 'unknown'
          ? 'Result unknown — check the terminal before retrying'
          : 'Could not write the draft',
        2400
      )
      return { applied: false }
    },
    [client, release, showToast]
  )

  const reloadConflict = useCallback(() => {
    const current = sessionRef.current
    if (!current || !conflict) {
      return
    }
    bufferedTerminalDraftState.setInput(conflict.text)
    setSession({ ...current, baseToken: conflict.sourceToken, remoteText: conflict.text })
    setConflict(null)
    showToast('Loaded the terminal version', 1400)
  }, [bufferedTerminalDraftState, conflict])

  const exitRemoteDraft = useCallback(() => {
    const current = sessionRef.current
    release(current)
    setSession(null)
    setConflict(null)
    showToast('Stopped editing the terminal draft', 1400)
  }, [release, showToast])

  const keepConflictMine = useCallback(() => {
    const current = sessionRef.current
    if (!current || !conflict) {
      return
    }
    setSession({ ...current, baseToken: conflict.sourceToken })
    setConflict(null)
    showToast('Saving will overwrite the terminal draft', 1800)
  }, [conflict])

  return {
    remoteDraftSession: session,
    remoteDraftConflict: conflict,
    loadRemoteDraft,
    saveRemoteDraft,
    submitRemoteDraft,
    exitRemoteDraft,
    reloadConflict,
    keepConflictMine
  }
}

export type MobileSessionRemoteDraftModel = MobileSessionTerminalWebviewModel &
  ReturnType<typeof useMobileSessionRemoteDraft>
