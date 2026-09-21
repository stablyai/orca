import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcSuccess } from '../transport/types'
import { browserErrorMessage, shouldSurfaceBrowserError } from './mobile-browser-frame-state'

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
  const pageParams = useCallback(() => {
    if (!pageId) {
      return null
    }
    return {
      worktree: `id:${worktreeId}`,
      page: pageId
    }
  }, [pageId, worktreeId])

  const sendBrowserRequest = useCallback(
    async (
      method: string,
      params: Record<string, unknown> = {},
      opts: { showBusy?: boolean; suppressError?: boolean; timeoutMs?: number } = {}
    ): Promise<unknown | null> => {
      const base = pageParams()
      if (!client || !base) {
        return null
      }
      if (opts.showBusy) {
        busyRef.current = true
        setBusy(true)
      }
      try {
        const response = await client.sendRequest(
          method,
          { ...base, ...params },
          { timeoutMs: opts.timeoutMs ?? 15_000 }
        )
        if (!response.ok) {
          throw new Error((response as RpcFailure).error.message)
        }
        setError(null)
        return (response as RpcSuccess).result
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
