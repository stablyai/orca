import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert } from 'react-native'
import { terminalDraftBegin, terminalDraftRelease } from '../terminal/mobile-terminal-operations'
import type { MobileSessionTerminalWebviewModel } from './use-mobile-session-terminal-webview'
import { useMobileRemoteDraftResolution } from './use-mobile-remote-draft-resolution'
import { useMobileRemoteDraftSave } from './use-mobile-remote-draft-save'
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
  const [uncertainHandles, setUncertainHandles] = useState<ReadonlySet<string>>(new Set())
  const sessionRef = useRef<MobileRemoteDraftSession | null>(null)
  const inputRef = useRef(bufferedTerminalDraftState.input)
  inputRef.current = bufferedTerminalDraftState.input
  const loadSeqRef = useRef(0)
  const operationGenerationsRef = useRef<Map<string, number>>(new Map())
  const operationGeneration = useCallback(
    (handle: string) => operationGenerationsRef.current.get(handle) ?? 0,
    []
  )
  const bumpOperationGeneration = useCallback(
    (handle: string) => {
      operationGenerationsRef.current.set(handle, operationGeneration(handle) + 1)
    },
    [operationGeneration]
  )
  const markUncertain = useCallback((handle: string) => {
    setUncertainHandles((current) => {
      if (current.has(handle)) {
        return current
      }
      const next = new Set(current)
      next.add(handle)
      return next
    })
  }, [])
  const clearUncertain = useCallback((handle: string) => {
    setUncertainHandles((current) => {
      if (!current.has(handle)) {
        return current
      }
      const next = new Set(current)
      next.delete(handle)
      return next
    })
  }, [])
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
      const generation = operationGeneration(handle)
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
      if (
        seq !== loadSeqRef.current ||
        generation !== operationGeneration(handle) ||
        handle !== activeHandleRef.current
      ) {
        const live = sessionRef.current
        // Release a lease the user abandoned (Exit or another terminal), but not one a newer load owns.
        if (!live || live.handle !== handle || live.epoch !== next.epoch) {
          release(next)
        }
        return
      }
      setSession(next)
      setConflict(null)
      clearUncertain(handle)
      bumpOperationGeneration(handle)
      bufferedTerminalDraftState.setInput(result.text)
      showToast('Loaded terminal draft', 1200)
    },
    [
      activeHandle,
      activeHandleRef,
      bufferedTerminalDraftState,
      client,
      connState,
      operationGeneration,
      release,
      showToast
    ]
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

  const saveRemoteDraft = useMobileRemoteDraftSave({
    client,
    deviceTokenRef,
    sessionRef,
    operationGeneration,
    isUncertain: (handle) => uncertainHandles.has(handle),
    getInput: () => inputRef.current,
    setInput: (value) => bufferedTerminalDraftState.setInput(value),
    setSession,
    setConflict,
    markUncertain,
    showToast
  })

  const submitRemoteDraft = useMobileRemoteDraftSubmit({
    client,
    deviceTokenRef,
    activeHandleRef,
    sessionRef,
    setSession,
    setConflict,
    markUncertain,
    operationGeneration,
    release,
    showToast
  })

  const resolution = useMobileRemoteDraftResolution({
    conflict,
    sessionRef,
    setSession,
    setConflict,
    clearUncertain,
    activeHandle,
    bumpOperationGeneration,
    setInput: (value) => bufferedTerminalDraftState.setInput(value),
    input: bufferedTerminalDraftState.input,
    release,
    showToast
  })

  const isRemoteDraftUncertain = (handle: string | null): boolean =>
    handle !== null && uncertainHandles.has(handle)
  const remoteDraftUncertain = isRemoteDraftUncertain(activeHandle)
  return {
    remoteDraftSession: session,
    remoteDraftConflict: conflict,
    remoteDraftUncertain,
    isRemoteDraftUncertain,
    reloadUncertainDraft: () => void begin(false),
    loadRemoteDraft,
    saveRemoteDraft,
    submitRemoteDraft,
    ...resolution
  }
}

export type MobileSessionRemoteDraftModel = MobileSessionTerminalWebviewModel &
  ReturnType<typeof useMobileSessionRemoteDraft>
