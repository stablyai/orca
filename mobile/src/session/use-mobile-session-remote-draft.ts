import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert } from 'react-native'
import {
  terminalDraftBegin,
  terminalDraftRelease,
  terminalDraftSave
} from '../terminal/mobile-terminal-operations'
import type { MobileSessionTerminalWebviewModel } from './use-mobile-session-terminal-webview'
import { useMobileRemoteDraftResolution } from './use-mobile-remote-draft-resolution'
import { useMobileRemoteDraftSubmit } from './use-mobile-remote-draft-submit'

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
  const [uncertain, setUncertain] = useState(false)
  const sessionRef = useRef<MobileRemoteDraftSession | null>(null)
  const loadSeqRef = useRef(0)
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
      loadSeqRef.current += 1
      const seq = loadSeqRef.current
      let result
      try {
        const response = await terminalDraftBegin.request(
          rpc,
          {
            terminal: handle,
            client: { id: deviceToken, type: 'mobile' },
            ...(force ? { force: true } : {})
          },
          { failWhenDisconnected: true }
        )
        result = terminalDraftBegin.interpret(response)
      } catch {
        showToast('Could not read the terminal draft — check the connection', 2200)
        return
      }
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
        seq !== loadSeqRef.current ||
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
      setUncertain(false)
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
    const sentText = bufferedTerminalDraftState.input
    let result
    try {
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
      result = terminalDraftSave.interpret(response)
    } catch {
      setUncertain(true)
      showToast('Result unknown — check the terminal before retrying', 2600)
      return
    }
    if (activeHandleRef.current !== current.handle || sessionRef.current?.epoch !== current.epoch) {
      return
    }
    if (result?.ok) {
      const actualText = typeof result.text === 'string' ? result.text : sentText
      if (bufferedTerminalDraftState.input === sentText && actualText !== sentText) {
        bufferedTerminalDraftState.setInput(actualText)
      }
      const next = {
        ...current,
        baseToken: result.sourceToken ?? current.baseToken,
        remoteText: actualText
      }
      setSession(next)
      setUncertain(false)
      showToast(
        result.normalized
          ? 'Saved; the agent expanded tabs or line endings'
          : result.replayed
            ? 'Already saved to terminal'
            : 'Saved to terminal',
        1600
      )
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

  const submitRemoteDraft = useMobileRemoteDraftSubmit({
    client,
    deviceTokenRef,
    activeHandleRef,
    sessionRef,
    setSession,
    setConflict,
    setUncertain,
    release,
    showToast
  })

  const resolution = useMobileRemoteDraftResolution({
    conflict,
    sessionRef,
    setSession,
    setConflict,
    setUncertain,
    setInput: (value) => bufferedTerminalDraftState.setInput(value),
    input: bufferedTerminalDraftState.input,
    release,
    showToast
  })

  return {
    remoteDraftSession: session,
    remoteDraftConflict: conflict,
    remoteDraftUncertain: uncertain,
    loadRemoteDraft,
    saveRemoteDraft,
    submitRemoteDraft,
    ...resolution
  }
}

export type MobileSessionRemoteDraftModel = MobileSessionTerminalWebviewModel &
  ReturnType<typeof useMobileSessionRemoteDraft>
