import { WORKTREE_CREATE_EXACT_NAME_TAKEN_CODE } from '../../../../src/shared/new-workspace/worktree-create-collision'
import { hasRuntimeRpcErrorCode } from '../../../../src/shared/runtime-rpc-error-code'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { readNewWorktreeRuntimeCapabilities } from '../../tasks/worktree-create-capability'
import { createWorktreeWithNameRetry } from '../../tasks/worktree-create-retry'

// The host's refusal before creating, when the repo asks to run or skip setup; desktop matches the same text.
const SETUP_DECISION_REQUIRED = 'Setup decision required for this repository'

// A created worktree reaches the list on the next catalog read; until then a second tap would be refused as taken.
const CREATED_HOLD_MS = 15_000

export type FolderRepoCreateState = 'creating' | 'created'

const states = new Map<string, FolderRepoCreateState>()
const listeners = new Set<() => void>()

function setState(key: string, state: FolderRepoCreateState | null): void {
  if (state) {
    states.set(key, state)
  } else {
    states.delete(key)
  }
  listeners.forEach((listener) => listener())
}

export function subscribeFolderRepoCreates(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getFolderRepoCreateState(key: string): FolderRepoCreateState | null {
  return states.get(key) ?? null
}

/** One create per repo of one folder on one host, whichever screen started it. */
export function folderRepoCreateKey(args: {
  hostId: string
  executionHost: string | undefined
  folderWorktreeId: string
  repoId: string
}): string {
  return [args.hostId, args.executionHost ?? '', args.folderWorktreeId, args.repoId].join('\0')
}

export type FolderRepoCreateOutcome =
  | { kind: 'created'; name: string; warning?: string }
  /** Refused before creating: a branch with that name exists, or the repo asks to run or skip setup. */
  | { kind: 'needs-composer' }
  /** A resent create was refused as taken: the first send may have made it, so read the list again. */
  | { kind: 'maybe-created' }
  | { kind: 'failed'; message: string }
  | { kind: 'already-running' }

/**
 * Creates a worktree named after the folder in one of its repositories, attached to the folder, the
 * way desktop's empty state does. Only for hosts that advertise exact-name creation.
 */
export async function createFolderRepoWorktree(args: {
  key: string
  /** The client that creates: the desktop's own, or scoped to the folder's server. */
  client: RpcClient
  repoId: string
  /** `folder:<id>`. */
  folderWorktreeId: string
  name: string
}): Promise<FolderRepoCreateOutcome> {
  if (states.has(args.key)) {
    return { kind: 'already-running' }
  }
  setState(args.key, 'creating')
  let created = false
  try {
    const result = await createWorktreeWithNameRetry({
      client: args.client,
      baseName: args.name,
      // One exact name: a numbered suffix would be a worktree the user didn't ask for.
      maxAttempts: 1,
      branchIntentSupported: true,
      worktreeCreateIdempotency: readNewWorktreeRuntimeCapabilities(args.client).then(
        (capabilities) => capabilities?.worktreeCreateIdempotency ?? false
      ),
      buildParams: (name) => ({
        repo: `id:${args.repoId}`,
        name,
        displayName: name,
        displayNameKind: 'user',
        branchIntent: 'create-exact',
        setupDecision: 'inherit',
        parentWorkspace: args.folderWorktreeId,
        parentWorkspaceOrigin: 'manual'
      })
    })
    if (!('error' in result)) {
      created = true
      return {
        kind: 'created',
        name: result.name,
        ...(result.warning ? { warning: result.warning } : {})
      }
    }
    const taken = hasRuntimeRpcErrorCode(result.error, WORKTREE_CREATE_EXACT_NAME_TAKEN_CODE)
    if (taken && result.replayed) {
      created = true
      return { kind: 'maybe-created' }
    }
    if (taken || result.error.includes(SETUP_DECISION_REQUIRED)) {
      return { kind: 'needs-composer' }
    }
    return { kind: 'failed', message: result.error }
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  } finally {
    if (created) {
      setState(args.key, 'created')
      setTimeout(() => {
        if (states.get(args.key) === 'created') {
          setState(args.key, null)
        }
      }, CREATED_HOLD_MS)
    } else {
      setState(args.key, null)
    }
  }
}
