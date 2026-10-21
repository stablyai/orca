import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc-operation-contract'

export type MobileRepoBaseRefSummary = {
  readonly id: string
  readonly worktreeBaseRef: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const repoBaseRefSummariesReader: RpcCompatibleReader<
  unknown,
  'repo-base-refs',
  MobileRepoBaseRefSummary[]
> = (raw) => ({
  compatible: true,
  variant: 'repo-base-refs',
  value:
    isRecord(raw) && Array.isArray(raw.repos)
      ? raw.repos.flatMap((candidate): MobileRepoBaseRefSummary[] =>
          isRecord(candidate) && typeof candidate.id === 'string'
            ? [
                {
                  id: candidate.id,
                  worktreeBaseRef:
                    typeof candidate.worktreeBaseRef === 'string' ? candidate.worktreeBaseRef : null
                }
              ]
            : []
        )
      : [],
  salvage: { droppedPaths: [], droppedCount: 0 }
})

/** Only the base-ref hint is read here; the repo catalog itself has its own callers. */
export const repoBaseRefListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.base-ref-list-or-skip',
    method: 'repo.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: repoBaseRefSummariesReader
  })
)

const defaultBaseRefReader: RpcCompatibleReader<unknown, 'default-base-ref', string | null> = (
  raw
) => ({
  compatible: true,
  variant: 'default-base-ref',
  value:
    isRecord(raw) && typeof raw.defaultBaseRef === 'string'
      ? raw.defaultBaseRef.trim() || null
      : null,
  salvage: { droppedPaths: [], droppedCount: 0 }
})

export const repoDefaultBaseRefRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.default-base-ref',
    method: 'repo.baseRefDefault',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: defaultBaseRefReader
  })
)
