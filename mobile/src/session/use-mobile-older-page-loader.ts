import { useCallback, useRef, useState } from 'react'
import { RPC_REQUEST_MIN_ACK_MS } from '../transport/rpc-request-budget'

/** One tap's whole wait, connect included, shared by every page it reads. */
export const OLDER_PAGE_BUDGET_MS = 15_000
/** Bounds the pages one tap reads past pages that draw nothing. */
export const OLDER_PAGES_PER_TAP = 8

export type OlderPageStep = 'drew' | 'drew-nothing' | 'end' | 'failed' | 'unavailable'

export type OlderPagePhase = 'idle' | 'loading' | 'failed' | 'unavailable'

export type OlderPageReader = (request: {
  timeoutMs: number
  isCurrent: () => boolean
}) => Promise<OlderPageStep>

// Own settlement and supersession together so either path clears paging progress.
export function useMobileOlderPageLoader(): {
  phase: OlderPagePhase
  load: (reader: OlderPageReader) => void
  /** The window the read was for is gone: ends it silently and clears the spinner and the line. */
  supersede: () => void
} {
  const [phase, setPhase] = useState<OlderPagePhase>('idle')
  // Only the running read's token may settle the phase, so a superseded read's late reply can't.
  const tokenRef = useRef<object | null>(null)
  // History that can't be read stays so until the window is replaced, whatever re-triggers a read.
  const unavailableRef = useRef(false)

  const load = useCallback((reader: OlderPageReader) => {
    if (tokenRef.current || unavailableRef.current) {
      return
    }
    const token = {}
    tokenRef.current = token
    setPhase('loading')
    const isCurrent = (): boolean => tokenRef.current === token
    const deadline = Date.now() + OLDER_PAGE_BUDGET_MS
    void (async (): Promise<OlderPageStep> => {
      let step: OlderPageStep = 'drew-nothing'
      for (let page = 0; page < OLDER_PAGES_PER_TAP && step === 'drew-nothing'; page += 1) {
        const timeoutMs = deadline - Date.now()
        // Too little left to be answered: what landed stays, and the next tap reads on.
        if (!isCurrent() || timeoutMs < RPC_REQUEST_MIN_ACK_MS) {
          return 'end'
        }
        step = await reader({ timeoutMs, isCurrent })
      }
      return step
    })()
      // Contain fire-and-forget page failures rather than leaking transport rejections.
      .catch((): OlderPageStep => 'failed')
      .then((step) => {
        if (isCurrent()) {
          tokenRef.current = null
          unavailableRef.current = step === 'unavailable'
          setPhase(step === 'failed' || step === 'unavailable' ? step : 'idle')
        }
      })
  }, [])

  const supersede = useCallback(() => {
    tokenRef.current = null
    unavailableRef.current = false
    setPhase('idle')
  }, [])

  return { phase, load, supersede }
}
