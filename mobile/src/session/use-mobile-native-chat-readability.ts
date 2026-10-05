import { useEffect, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  nativeChatRepoListRead,
  type MobileRuntimeRepoSummary
} from './mobile-session-read-operations'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import { resumeFolderWorkspaceListRead } from '../agent-history/mobile-agent-history-operations'
import {
  isMobileFolderNativeChatReadable,
  isMobileNativeChatTranscriptReadable
} from './mobile-native-chat-eligibility'
import { getRepoIdFromMobileWorktreeId } from './mobile-session-route-helpers'
import type { MobileNativeChatReadability } from './mobile-session-chat-view'

type ReadabilityState = {
  client: RpcClient | null
  worktreeId: string
  readability: MobileNativeChatReadability
}

const READABILITY_RETRY_DELAYS_MS = [2_000, 10_000, 30_000]

// Why per host and worktree: a re-read after a client swap must not regress a settled answer to unknown or failed.
const settledReadabilityByScope = new Map<string, 'readable' | 'unreadable'>()

function readabilityScope(hostId: string | null, worktreeId: string): string | null {
  return hostId === null ? null : `${hostId}\0${worktreeId}`
}

async function readTranscriptReadability(client: RpcClient, worktreeId: string): Promise<boolean> {
  if (worktreeId.startsWith('folder:')) {
    const result = resumeFolderWorkspaceListRead.interpret(
      await resumeFolderWorkspaceListRead.request(client)
    )
    return result.accepted && isMobileFolderNativeChatReadable(result.value, worktreeId)
  }
  const accepted = nativeChatRepoListRead.interpret(await nativeChatRepoListRead.request(client))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
  const repos = accepted.accepted ? ((accepted.value as MobileRuntimeRepoSummary[]) ?? []) : []
  const repoId = getRepoIdFromMobileWorktreeId(worktreeId)
  const repo = repos.find((candidate) => candidate.id === repoId)
  return repo ? isMobileNativeChatTranscriptReadable(repo.connectionId ?? null) : false
}

/** Reads until an answer, retrying a failure a bounded number of times; returns the cancel. */
function readWithBoundedRetry(
  read: () => Promise<boolean>,
  onAnswer: (readable: boolean) => void,
  onFailure: () => void
): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const attempt = (failures: number): void => {
    void read().then(
      (readable) => {
        if (!cancelled) {
          onAnswer(readable)
        }
      },
      () => {
        if (cancelled) {
          return
        }
        onFailure()
        // Why bounded: a host that keeps failing must not be polled for the life of the screen.
        const delay = READABILITY_RETRY_DELAYS_MS[failures]
        if (delay !== undefined) {
          timer = setTimeout(() => attempt(failures + 1), delay)
        }
      }
    )
  }
  attempt(0)
  return () => {
    cancelled = true
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export function useMobileNativeChatReadability(
  client: RpcClient | null,
  worktreeId: string
): boolean {
  return useMobileNativeChatReadabilityState(client, null, worktreeId) === 'readable'
}

/** Tri-state readability: `unknown` while the read is pending, `failed` once it could not be read. */
export function useMobileNativeChatReadabilityState(
  client: RpcClient | null,
  hostId: string | null,
  worktreeId: string
): MobileNativeChatReadability {
  const isFloatingWorkspace = isFloatingWorkspaceWorktreeId(worktreeId)
  const scope = readabilityScope(hostId, worktreeId)
  const [state, setState] = useState<ReadabilityState>({
    client: null,
    worktreeId: '',
    readability: 'unknown'
  })
  useEffect(() => {
    // Why: the floating workspace always runs on the paired host and has no repo connection to resolve.
    // With no client the render already falls back to the stored answer.
    if (isFloatingWorkspace || !client) {
      return
    }
    return readWithBoundedRetry(
      () => readTranscriptReadability(client, worktreeId),
      (readable) => {
        const readability = readable ? 'readable' : 'unreadable'
        if (scope !== null) {
          settledReadabilityByScope.set(scope, readability)
        }
        setState({ client, worktreeId, readability })
      },
      () => setState({ client, worktreeId, readability: 'failed' })
    )
  }, [client, isFloatingWorkspace, scope, worktreeId])
  if (isFloatingWorkspace) {
    return 'readable'
  }
  // Why: route reuse renders before its new effect resolves; never expose the
  // previous repo's readability under a different client/worktree key.
  const current =
    state.client === client && state.worktreeId === worktreeId ? state.readability : 'unknown'
  if (current === 'readable' || current === 'unreadable') {
    return current
  }
  // Why: a pending, failed or client-less read keeps the answer stored for this host and worktree.
  return (scope !== null ? settledReadabilityByScope.get(scope) : undefined) ?? current
}
