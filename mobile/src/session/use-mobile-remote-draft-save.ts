import { useCallback } from 'react'
import type { RefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { terminalDraftSave } from '../terminal/mobile-terminal-operations'
import type {
  MobileRemoteDraftConflict,
  MobileRemoteDraftSession
} from './use-mobile-session-remote-draft'

function operationId(): string {
  return `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function useMobileRemoteDraftSave({
  client,
  deviceTokenRef,
  sessionRef,
  operationGeneration,
  isUncertain,
  getInput,
  setInput,
  setSession,
  setConflict,
  markUncertain,
  showToast
}: {
  client: RpcClient | null
  deviceTokenRef: RefObject<string | null>
  sessionRef: RefObject<MobileRemoteDraftSession | null>
  operationGeneration: (handle: string) => number
  isUncertain: (handle: string) => boolean
  getInput: () => string
  setInput: (value: string) => void
  setSession: (session: MobileRemoteDraftSession | null) => void
  setConflict: (conflict: MobileRemoteDraftConflict | null) => void
  markUncertain: (handle: string) => void
  showToast: (message: string, duration?: number) => void
}) {
  return useCallback(async () => {
    const current = sessionRef.current
    const rpc = client
    const deviceToken = deviceTokenRef.current
    if (!current || !rpc || !deviceToken) {
      showToast('Load the terminal draft first', 1600)
      return
    }
    if (isUncertain(current.handle)) {
      showToast('Result unknown — check the terminal before saving again', 2200)
      return
    }
    const sentText = getInput()
    const generation = operationGeneration(current.handle)
    let result
    try {
      const response = await terminalDraftSave.request(
        rpc,
        {
          terminal: current.handle,
          client: { id: deviceToken, type: 'mobile' },
          epoch: current.epoch,
          baseToken: current.baseToken,
          text: sentText,
          operationId: operationId()
        },
        { failWhenDisconnected: true }
      )
      result = terminalDraftSave.interpret(response)
    } catch {
      if (operationGeneration(current.handle) !== generation) {
        return
      }
      markUncertain(current.handle)
      showToast('Result unknown — check the terminal before retrying', 2600)
      return
    }
    if (generation !== operationGeneration(current.handle)) {
      return
    }
    if (activeSessionChanged(sessionRef.current, current)) {
      return
    }
    if (result?.ok) {
      const actualText = typeof result.text === 'string' ? result.text : sentText
      if (getInput() === sentText && actualText !== sentText) {
        setInput(actualText)
      }
      setSession({
        ...current,
        baseToken: result.sourceToken ?? current.baseToken,
        remoteText: actualText
      })
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
    if (result?.status === 'locked') {
      showToast('Another device is using terminal input. Nothing was written.', 2400)
      return
    }
    if (result?.status === 'stale_binding') {
      showToast('This terminal changed. Reload the draft.', 2400)
      return
    }
    showToast(
      result?.status === 'unknown'
        ? 'Result unknown — check the terminal before retrying'
        : 'Could not save the draft',
      2400
    )
  }, [
    client,
    deviceTokenRef,
    getInput,
    isUncertain,
    markUncertain,
    operationGeneration,
    sessionRef,
    setConflict,
    setInput,
    setSession,
    showToast
  ])
}

function activeSessionChanged(
  current: MobileRemoteDraftSession | null,
  started: MobileRemoteDraftSession
): boolean {
  return current === null || current.handle !== started.handle || current.epoch !== started.epoch
}
