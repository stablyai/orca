import { findClaudeTranscriptProjectFolder } from '../../shared/claude-project-dir-encoding'
import { probeRecoveredStartupCwdDirectory } from '../ipc/pty/host-env/startup-cwd-directory-exists'

/** The folder a shell revived from crash history starts in. */
export async function resolveColdRestoreStartupCwd(args: {
  /** The shell's last reported folder, from the recovered checkpoint. */
  recoveredCwd: string | undefined
  /** The spawn's own folder, already resolved by the request. */
  requestedCwd: string
  claudeResumeTranscriptPath: string | undefined
}): Promise<string> {
  // Why: the last reported folder follows an agent's `cd`; a Claude resume started there misses
  // its session's project, so it asks for trust and runs without the project's rules (#31545).
  const startupCwd =
    findClaudeTranscriptProjectFolder(args.claudeResumeTranscriptPath, [
      args.requestedCwd,
      args.recoveredCwd
    ]) ?? args.recoveredCwd
  // Why: a recovered folder deleted since the crash yields to the request's already-resolved cwd.
  return startupCwd && (await probeRecoveredStartupCwdDirectory(startupCwd)) !== false
    ? startupCwd
    : args.requestedCwd
}
