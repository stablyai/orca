// Cancel for "Move to this computer": a prepare can be stopped while it packs or downloads, and
// refuses once the branch import begins (from there the move goes on). One prepare per workspace
// at a time: a second (Try again after a timeout, another window) is refused until the first ends,
// so two runs never share the VM's scratch folder or import the branch twice.
import type {
  CloudTransferPrepared,
  CloudTransferResult
} from '../../shared/hosted-sandbox/cloud-transfer-api'
import type { CloudTransferManifest } from '../../shared/hosted-sandbox/cloud-transfer-pack'

/** An apply for this transfer is already running (finish and "Apply changes again" share it). */
export const busy = <T>(): CloudTransferResult<T> => ({
  ok: false,
  code: 'busy',
  message: 'Changes from this move are already being applied.'
})

/** What prepare hands the window: where to create the local workspace, and what came across. */
export function preparedValue(
  transferId: string,
  repoId: string,
  branch: string,
  manifest: CloudTransferManifest
): CloudTransferPrepared {
  // A pushed branch tracks itself: then its base is the project's default, not itself.
  const upstream = manifest.upstream?.replace(/^[^/]+\//, '') ?? null
  return {
    transferId,
    repoId,
    branch,
    cloudBranch: manifest.branch,
    baseBranch: upstream && upstream !== manifest.branch ? upstream : null,
    counts: {
      untrackedFiles: manifest.untrackedFiles,
      claudeSessions: manifest.claudeSessions,
      codexSessions: manifest.codexSessions,
      hasChanges: manifest.stagedBytes + manifest.unstagedBytes > 0 || manifest.untrackedFiles > 0
    }
  }
}

/** A failure the window names (too large, no commits…) instead of the step's generic cause. */
export class CloudTransferError extends Error {
  constructor(
    readonly code: 'too_large' | 'no_commits',
    message: string
  ) {
    super(message)
  }
}

export function createCloudTransferCancels(): {
  /** Null while another prepare for this workspace is still running. */
  begin: (workspaceId: string) => AbortSignal | null
  /** Throws if cancelled; past this point Cancel is refused. */
  commit: (workspaceId: string, signal: AbortSignal) => void
  end: (workspaceId: string, signal: AbortSignal) => void
  /** True when honoured (or nothing to stop yet: the window stops it); false once importing. */
  cancel: (workspaceId: string) => boolean
} {
  const cancellable = new Map<string, AbortController>()
  const importing = new Set<string>()
  return {
    begin: (workspaceId) => {
      if (cancellable.has(workspaceId) || importing.has(workspaceId)) {
        return null
      }
      const controller = new AbortController()
      cancellable.set(workspaceId, controller)
      return controller.signal
    },
    commit: (workspaceId, signal) => {
      signal.throwIfAborted()
      cancellable.delete(workspaceId)
      importing.add(workspaceId)
    },
    end: (workspaceId, signal) => {
      if (cancellable.get(workspaceId)?.signal === signal) {
        cancellable.delete(workspaceId)
      }
      importing.delete(workspaceId)
    },
    cancel: (workspaceId) => {
      const controller = cancellable.get(workspaceId)
      controller?.abort(new Error('cancelled'))
      return controller !== undefined || !importing.has(workspaceId)
    }
  }
}
