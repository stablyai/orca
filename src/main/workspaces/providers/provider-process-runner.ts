import { runProcess } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import { MAX_WORKTREE_PROVIDER_STDOUT_BYTES } from '../../../shared/worktree/provider/worktree-provider-types'

export type WorktreeProviderCommandPhase = 'claim' | 'release' | 'setup' | 'status'

export class WorktreeProviderError extends Error {
  readonly code: string
  readonly data: Record<string, unknown>

  constructor(code: string, message: string, data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'WorktreeProviderError'
    this.code = code
    this.data = data
  }
}

function describeCommand(argv: readonly string[]): string {
  return argv[0] ? `${argv[0]}` : 'provider command'
}

/** Run an argv array without a shell; nonzero exits resolve so callers can map refusals. */
export async function runWorktreeProviderCommand(args: {
  argv: readonly string[]
  cwd: string
  timeoutMs: number
  provider: string
  phase: WorktreeProviderCommandPhase
}): Promise<ProcessResult> {
  const program = args.argv[0]
  if (!program) {
    throw new WorktreeProviderError(
      'worktree_provider_command_failed',
      `Provider "${args.provider}" has an empty ${args.phase} command.`,
      { provider: args.provider, phase: args.phase }
    )
  }
  try {
    return await runProcess(
      {
        program,
        args: args.argv.slice(1),
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        maxOutputBytes: MAX_WORKTREE_PROVIDER_STDOUT_BYTES,
        killOnOutputLimit: true
      },
      'tail'
    )
  } catch (error) {
    throw new WorktreeProviderError(
      'worktree_provider_command_failed',
      `Could not run provider "${args.provider}" ${args.phase} command (${describeCommand(args.argv)}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { provider: args.provider, phase: args.phase }
    )
  }
}
