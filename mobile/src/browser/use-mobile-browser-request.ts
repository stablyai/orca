import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import { browserErrorMessage, shouldSurfaceBrowserError } from './mobile-browser-frame-state'

export type BrowserPageParams = { worktree: string; page: string }
/**
 * One command against the current page. It receives the client, the page params and the send
 * options rather than choosing them, so the page guard, the busy flag and the 15 s default live
 * here for every command instead of once per call site.
 */
export type BrowserPageCommandSend<Value = unknown> = (
  client: RpcClient,
  base: BrowserPageParams,
  options: SendRequestOptions
) => Promise<Value>

type BrowserRequestArgs = {
  busyRef: { current: boolean }
  client: RpcClient | null
  pageId: string | null
  setBusy: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string | null>>
  worktreeId: string
}
export function useMobileBrowserRequest(args: BrowserRequestArgs) {
  const { busyRef, client, pageId, setBusy, setError, worktreeId } = args
  const pageParams = useCallback((): BrowserPageParams | null => {
    if (!pageId) {
      return null
    }
    return {
      worktree: `id:${worktreeId}`,
      page: pageId
    }
  }, [pageId, worktreeId])

  // Generic in the command's own value so a checked reply reaches its caller as what the reader
  // decoded; a refused or failed command is the `null` every call site already tests for.
  const sendBrowserRequest = useCallback(
    // A named function expression rather than a generic arrow: the recorder's module loader
    // transpiles product sources with the JSX runtime on, where `<Value>` parses as an element.
    async function sendBrowserCommand<Value>(
      send: BrowserPageCommandSend<Value>,
      opts: { showBusy?: boolean; suppressError?: boolean; timeoutMs?: number } = {}
    ): Promise<Value | null> {
      const base = pageParams()
      if (!client || !base) {
        return null
      }
      if (opts.showBusy) {
        busyRef.current = true
        setBusy(true)
      }
      try {
        const result = await send(client, base, { timeoutMs: opts.timeoutMs ?? 15_000 })
        setError(null)
        return result
      } catch (err) {
        const message = browserErrorMessage(err, 'Browser command failed')
        if (!opts.suppressError && shouldSurfaceBrowserError(message)) {
          setError(message)
        }
        return null
      } finally {
        if (opts.showBusy) {
          busyRef.current = false
          setBusy(false)
        }
      }
    },
    [client, pageParams]
  )
  return { pageParams, sendBrowserRequest }
}
