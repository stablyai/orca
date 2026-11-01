import { useCallback, useLayoutEffect, useRef, useState, type SetStateAction } from 'react'
import type { ActionableTaskItem } from './mobile-tasks-project-workspace-types'
import type { DetailPayload, GitHubWorkItem } from './mobile-tasks-provider-detail-types'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  githubWorkItemTargetKey,
  resolveGitHubWorkItemTarget,
  matchesGitHubWorkItemTarget
} from '../../../src/shared/github/work-item-target'
import type { TaskItem } from './mobile-tasks-legacy-foundation'

export function githubTaskKey(source: GitHubWorkItem): string {
  const target = resolveGitHubWorkItemTarget(source)
  return [source.repoId, target ? githubWorkItemTargetKey(target) : source.url].join('\0')
}

export function sameGitHubTask(
  current: TaskItem | null,
  item: Extract<TaskItem, { provider: 'github' }>
): current is Extract<TaskItem, { provider: 'github' }> {
  return (
    current?.provider === 'github' && githubTaskKey(current.source) === githubTaskKey(item.source)
  )
}

export function requireGitHubTaskTarget(source: GitHubWorkItem) {
  const target = resolveGitHubWorkItemTarget(source)
  if (!target || !matchesGitHubWorkItemTarget(source, target)) {
    throw new Error('Unable to identify this GitHub item. Open it again from Tasks.')
  }
  return target
}

export function useMobileTasksSelection(
  client: RpcClient | null,
  details: DetailPayload | null,
  // The shared file owner's retire/recover step, run from this listener for each real connection change.
  onConnectionChange: (connected: boolean) => void
) {
  const [actionItem, publishItem] = useState<ActionableTaskItem | null>(null)
  const owner = useRef({ item: actionItem, visit: {}, client, revision: 0, details, live: true })
  useLayoutEffect(() => {
    const current = owner.current
    if (current.client !== client) {
      current.revision += 1
      current.client = client
    }
    current.details = details
  }, [client, details])
  useLayoutEffect(() => {
    owner.current.live = true
    let observed: { state: ConnectionState; generation: number | undefined } | null = null
    // One owner sees every raw (state, generation) change, including a down/up pair in one render.
    const reconcile = (state: ConnectionState) => {
      const generation = client?.getGeneration?.()
      if (observed?.state === state && Object.is(observed.generation, generation)) {
        return
      }
      const first = observed === null
      observed = { state, generation }
      if (first) {
        return
      }
      if (state !== 'connected') {
        owner.current.revision += 1
      }
      onConnectionChange(state === 'connected')
    }
    const stop = client?.onStateChange(reconcile)
    if (client) {
      reconcile(client.getState())
    }
    return () => {
      stop?.()
      owner.current.live = false
      owner.current.revision += 1
    }
  }, [client, onConnectionChange])
  const setActionItem = useCallback((update: SetStateAction<ActionableTaskItem | null>) => {
    const current = owner.current
    const next = typeof update === 'function' ? update(current.item) : update
    const key = (item: ActionableTaskItem | null) =>
      item?.provider === 'github' ? githubTaskKey(item.source) : (item?.key ?? null)
    if (key(next) !== key(current.item)) {
      current.visit = {}
    }
    current.item = next
    publishItem(next)
  }, [])
  const claimPublication = useCallback((item: TaskItem | null, accepted?: DetailPayload | null) => {
    const current = owner.current
    const { visit, client: selected, revision } = current
    const generation = selected?.getGeneration?.()
    return () =>
      current.live &&
      current.visit === visit &&
      current.client === selected &&
      current.revision === revision &&
      selected?.getState() === 'connected' &&
      selected.getGeneration?.() === generation &&
      (item?.provider !== 'github' || sameGitHubTask(current.item, item)) &&
      (accepted?.provider !== 'github' ||
        (current.details?.provider === 'github' &&
          current.details.targetKey === accepted.targetKey &&
          current.details.headSha === accepted.headSha &&
          current.details.baseSha === accepted.baseSha))
  }, [])
  return { actionItem, setActionItem, claimPublication }
}
