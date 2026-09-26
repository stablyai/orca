import { runProcess } from '../../../shared/child-process/run-process'

const CLAUDE_HELP_TIMEOUT_MS = 10_000

/** Resolves once whether this host's `claude --help` advertises `flag`; a missing CLI reads as unadvertised. */
export function createClaudeHelpFlagProbe(
  flag: string,
  run: typeof runProcess = runProcess
): () => Promise<boolean> {
  let advertised: Promise<boolean> | null = null
  return () => {
    advertised ??= run({ program: 'claude', args: ['--help'], timeoutMs: CLAUDE_HELP_TIMEOUT_MS })
      .then((result) => result.code === 0 && result.stdout.includes(flag))
      .catch(() => false)
    return advertised
  }
}
