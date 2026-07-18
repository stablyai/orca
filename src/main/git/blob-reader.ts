// Why: single seam that knows how to fetch raw git blob bytes. Strategy
// selection (CLI vs. native) lives here so status.ts keeps only
// result-shaping semantics.
import { gitExecFileAsyncBuffer } from './runner'
import { isMaxBufferOverflowError } from './max-buffer-overflow'
import { gitOptionsForWorktree, type GitRuntimeOptions } from './git-runtime-options'

export const MAX_GIT_SHOW_BYTES = 10 * 1024 * 1024

// Mirrors NativeBlobResult but names the payload `bytes` (domain) vs its `data` (napi ABI); Task 8's native→raw adapter maps between them.
export type RawBlobOutcome = { found: boolean; tooLarge: boolean; bytes?: Buffer }

export type BlobReadRequest =
  | { kind: 'rev'; worktreePath: string; rev: string; gitPath: string }
  | { kind: 'index'; worktreePath: string; gitPath: string }

export async function readGitBlobRaw(
  request: BlobReadRequest,
  options: GitRuntimeOptions = {}
): Promise<RawBlobOutcome> {
  // Native strategies land in a later change; CLI is the only path for now.
  return readBlobViaCli(request, options)
}

async function readBlobViaCli(
  request: BlobReadRequest,
  options: GitRuntimeOptions
): Promise<RawBlobOutcome> {
  const args =
    request.kind === 'rev'
      ? ['show', '--end-of-options', `${request.rev}:${request.gitPath}`]
      : ['show', `:${request.gitPath}`]
  try {
    const { stdout } = await gitExecFileAsyncBuffer(args, {
      ...gitOptionsForWorktree(request.worktreePath, options),
      maxBuffer: MAX_GIT_SHOW_BYTES
    })
    return { found: true, tooLarge: false, bytes: stdout }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      // Why: overflow means the blob exists but exceeds the read cap; callers
      // treat it as present-but-unreadable, distinct from a missing path.
      return { found: true, tooLarge: true }
    }
    return { found: false, tooLarge: false }
  }
}

export function resetNativeGitBlobReadStateForTests(): void {
  // Populated when native strategies land; exists now so tests share one API.
}
