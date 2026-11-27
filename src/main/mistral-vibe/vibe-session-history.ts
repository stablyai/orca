import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Mistral Vibe stores its sessions and sign-in under ~/.vibe (or VIBE_HOME).
// The ACP server (`vibe-acp`) and the interactive CLI (`vibe`) share this store and session IDs.
export const VIBE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['mistral-vibe'],
  rowSessionId: (link) => link.handle.nativeId,
  // Vibe's CLI resumes a specific session with --resume <SESSION_ID>; a bare --resume (or -c/--continue)
  // opens a picker / continues the last session, so both are targetless.
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue'],
      markers: ['--resume']
    })
}
