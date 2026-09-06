import { useCallback, type MutableRefObject } from 'react'
import type { useRouter } from 'expo-router'
import type { RuntimeGitLocalBranches } from '../../../src/shared/runtime-types'
import type { RpcClient } from '../transport/rpc-client'

type Params = {
  client: RpcClient | null
  hostId: string
  worktreeId: string
  router: ReturnType<typeof useRouter>
  sendGitRequest: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
  runGitAction: (
    actionId: string,
    method: string,
    params: Record<string, unknown>
  ) => Promise<boolean>
  mountedRef: MutableRefObject<boolean>
  setShowActionSheet: (next: boolean) => void
  setLocalBranches: (next: RuntimeGitLocalBranches | null) => void
  setShowBranchPicker: (next: boolean) => void
  onOpenHistory?: () => void
}

export function useMobileSourceControlBranchRunners(params: Params) {
  const {
    client,
    hostId,
    worktreeId,
    router,
    sendGitRequest,
    runGitAction,
    mountedRef,
    setShowActionSheet,
    setLocalBranches,
    setShowBranchPicker,
    onOpenHistory
  } = params

  const openBranchPicker = useCallback(() => {
    setShowActionSheet(false)
    setLocalBranches(null)
    setShowBranchPicker(true)
    if (!client) {
      return
    }
    void sendGitRequest<RuntimeGitLocalBranches>('git.localBranches')
      .then((result) => {
        if (mountedRef.current) {
          setLocalBranches(result)
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setLocalBranches({ current: null, branches: [] })
        }
      })
  }, [
    client,
    mountedRef,
    sendGitRequest,
    setLocalBranches,
    setShowActionSheet,
    setShowBranchPicker
  ])

  const openHistory = useCallback(() => {
    setShowActionSheet(false)
    if (onOpenHistory) {
      onOpenHistory()
      return
    }
    if (hostId && worktreeId) {
      router.push({
        pathname: '/h/[hostId]/source-control/[worktreeId]',
        params: { hostId, worktreeId, tab: 'history' }
      } as Parameters<typeof router.push>[0])
    }
  }, [hostId, onOpenHistory, router, setShowActionSheet, worktreeId])

  const checkoutBranch = useCallback(
    async (branch: string) => {
      setShowBranchPicker(false)
      await runGitAction('checkout', 'git.checkout', { branch })
    },
    [runGitAction, setShowBranchPicker]
  )

  return { openBranchPicker, openHistory, checkoutBranch }
}
