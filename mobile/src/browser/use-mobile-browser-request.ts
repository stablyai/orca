import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import { browserErrorMessage, shouldSurfaceBrowserError } from './mobile-browser-frame-state'

export type BrowserPageParams = { worktree: string; page: string }
// Centralize current-page guard, busy state and 15s default; caller supplies client/page/send options.
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

  // Generic reply type preserves reader’s checked value; refused/failed commands stay caller-checked null.
  const sendBrowserRequest = useCallback(
    // Use named generic function: recorder transpiles with JSX runtime, where generic arrow <Value> parses as element.
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
