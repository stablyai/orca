import { dropAgentResumeArgvFromCommand } from '../../shared/agent-resume-argv-drop'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'

export const UNVERIFIED_CODEX_RESUME_ERROR =
  'Orca could not verify the originating Codex session file, so automatic resume was stopped to avoid using a different account.'

/** Avoid cross-account resumes; reject unstrippable locators only when metadata claims Codex provenance. */
export function dropUnverifiedCodexResumeArgv(args: {
  command: string | undefined
  providerSession: AgentProviderSessionMetadata | null
  claimedCodexProvenance: boolean
}): { command: string | undefined; droppedResumeArgv: boolean } {
  if (!args.command || !args.providerSession) {
    return { command: args.command, droppedResumeArgv: false }
  }
  const drop = dropAgentResumeArgvFromCommand({
    command: args.command,
    agent: 'codex',
    providerSession: args.providerSession
  })
  if (drop.status === 'dropped') {
    return { command: drop.command, droppedResumeArgv: true }
  }
  if (drop.status === 'unrecognized' && args.claimedCodexProvenance) {
    throw new Error(UNVERIFIED_CODEX_RESUME_ERROR)
  }
  return { command: args.command, droppedResumeArgv: false }
}
