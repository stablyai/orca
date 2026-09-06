import { getAgentResumeArgv } from '../../shared/agent-session-resume'
import { buildAgentResumeLaunchCommand } from '../../shared/agent-resume-launch-command'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'

export type OmpRpcResumeLaunchArgs = {
  baseCommand: string
  shell: AgentStartupShell
  sessionFile: string
  sessionId: string
}

/** The PTY launch that resumes the session an RPC child just handed back. */
export function buildOmpRpcResumeLaunch(args: OmpRpcResumeLaunchArgs): string {
  const resumeArgv = getAgentResumeArgv(
    'omp',
    { key: 'session_id', id: args.sessionId },
    args.sessionFile
  )
  if (!resumeArgv) {
    throw new Error('OMP RPC session identity could not build a PTY resume launch')
  }
  return buildAgentResumeLaunchCommand('omp', args.baseCommand, resumeArgv, args.shell)
}
