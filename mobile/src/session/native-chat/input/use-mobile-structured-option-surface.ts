import { translate } from '../../../i18n/mobile-i18n'
import * as z from 'zod'
import {
  createNativeChatReviewMenu,
  type NativeChatReviewMenu,
  type NativeChatReviewRun
} from '../../../../../src/shared/native-chat/input/native-chat-review-menu'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../transport/rpc/rpc-operation-result-reader'
import { gitHistoryRead } from '../../../source-control/git/mobile-git-read-operations'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'

const reviewBranchesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.review-branches',
    method: 'git.localBranches',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('review-branches', z.object({ branches: z.array(z.string()) }))
  })
)

export function useMobileStructuredOptionSurface(args: {
  client: RpcClient | null
  worktreeId?: string
  onError?: (message: string) => void
  admits: NonNullable<SessionOptionsSurface['admits']>
  demandModelCatalog: () => void
  optionSnapshot: SessionOptionDescriptor[]
  setStructuredOption: (id: string, value: SessionOptionValue) => Promise<boolean>
  readOptionSnapshot: () => SessionOptionDescriptor[]
}) {
  const { admits, optionSnapshot, readOptionSnapshot, setStructuredOption, demandModelCatalog } =
    args
  const snapshotRef = useRef(readOptionSnapshot)
  useLayoutEffect(() => {
    snapshotRef.current = readOptionSnapshot
  }, [readOptionSnapshot])
  const [optionPickerRequest, setOptionPickerRequest] = useState<{
    id: string
    sequence: number
    review?: NativeChatReviewMenu
  } | null>(null)

  const invokeStructuredOption = useCallback(
    async (id: string, review?: NativeChatReviewRun) => {
      if (id === 'review' && review && args.client && args.worktreeId) {
        const client = args.client
        const worktree = `id:${args.worktreeId}`
        const branches = async () =>
          reviewBranchesRead.interpret(await reviewBranchesRead.request(client, { worktree }))
            .branches
        const menu = createNativeChatReviewMenu({
          copy: {
            baseBranch: translate('nativeChat.review.baseBranch', 'Review against a base branch'),
            uncommittedChanges: translate(
              'nativeChat.review.uncommittedChanges',
              'Review uncommitted changes'
            ),
            commit: translate('nativeChat.review.commit', 'Review a commit'),
            custom: translate('nativeChat.review.custom', 'Custom review instructions'),
            loadFailed: translate(
              'nativeChat.review.loadFailed',
              'Codex could not load review targets. Try /review again.'
            )
          },
          hasGit: !args.worktreeId.startsWith('folder:'),
          branches,
          commits: async () =>
            gitHistoryRead.interpret(await gitHistoryRead.request(client, { worktree, limit: 100 }))
              .items,
          run: review,
          onError: (message) => args.onError?.(message)
        })
        setOptionPickerRequest((current) => ({
          id,
          sequence: (current?.sequence ?? 0) + 1,
          review: menu
        }))
        return true
      }
      if (!optionSnapshot.some((entry) => entry.id === id)) {
        return false
      }
      setOptionPickerRequest((current) => ({ id, sequence: (current?.sequence ?? 0) + 1 }))
      return true
    },
    [optionSnapshot, args.client, args.worktreeId, args.onError]
  )

  const setOption = useCallback(
    async (id: string, value: SessionOptionValue) => {
      await setStructuredOption(id, value)
      return { snapshot: snapshotRef.current() }
    },
    [setStructuredOption]
  )

  const optionSurface = useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshot,
      admits,
      demandModelCatalog,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {}
    }),
    [optionSnapshot, setOption, demandModelCatalog, admits]
  )

  return { optionPickerRequest, invokeStructuredOption, optionSurface }
}
