import { useCallback } from 'react'
import type { RefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { terminalDraftSubmit } from '../terminal/mobile-terminal-operations'
import type {
  MobileRemoteDraftConflict,
  MobileRemoteDraftSession,
  MobileRemoteDraftSubmitOutcome
} from './use-mobile-session-remote-draft'

function operationId(): string {
  return `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function useMobileRemoteDraftSubmit({
  client,
  deviceTokenRef,
  activeHandleRef,
  sessionRef,
  setSession,
  setConflict,
  setUncertain,
  release,
  showToast
}: {
  client: RpcClient | null
  deviceTokenRef: RefObject<string | null>
  activeHandleRef: RefObject<string | null>
  sessionRef: RefObject<MobileRemoteDraftSession | null>
  setSession: (session: MobileRemoteDraftSession | null) => void
  setConflict: (conflict: MobileRemoteDraftConflict | null) => void
  setUncertain: (uncertain: boolean) => void
  release: (session: MobileRemoteDraftSession | null) => void
  showToast: (message: string, duration?: number) => void
}) {
  return useCallback(
    async (text: string): Promise<MobileRemoteDraftSubmitOutcome> => {
      const current = sessionRef.current
      const rpc = client
      const deviceToken = deviceTokenRef.current
      if (!current || !rpc || !deviceToken) {
        return { applied: false }
      }
      let result
      try {
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
        result = terminalDraftSubmit.interpret(response)
      } catch {
        if (
          activeHandleRef.current === current.handle &&
          sessionRef.current?.epoch === current.epoch
        ) {
          setUncertain(true)
          showToast('Result unknown — check the terminal before sending again', 2600)
        }
        return { applied: false }
      }
      if (!result) {
        showToast("This Orca host doesn't support draft editing yet", 2200)
        return { applied: false }
      }
      if (
        activeHandleRef.current !== current.handle ||
        sessionRef.current?.epoch !== current.epoch
      ) {
        if (!result.ok) {
          return { applied: false }
        }
        return {
          applied: true,
          status:
            result.status === 'submitted' || result.status === 'saved_not_submitted'
              ? result.status
              : 'submit_unknown'
        }
      }
      if (result.ok && result.status === 'submitted') {
        release(current)
        setSession(null)
        setConflict(null)
        setUncertain(false)
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
        // Why: keep the session banner so the user can reload/exit; uncertainty blocks every send path.
        if (result.sourceToken) {
          setSession({ ...current, baseToken: result.sourceToken })
        }
        setUncertain(true)
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
    [
      activeHandleRef,
      client,
      deviceTokenRef,
      release,
      sessionRef,
      setConflict,
      setSession,
      setUncertain,
      showToast
    ]
  )
}
