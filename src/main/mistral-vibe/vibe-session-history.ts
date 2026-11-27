import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Mistral Vibe stores its sessions and sign-in under ~/.vibe (or VIBE_HOME).
// The ACP server (`vibe-acp`) and the interactive CLI (`vibe`) share this store and session IDs.
// Session IDs are passed via --session-id on both `vibe` (terminal) and `vibe-acp` (ACP).
export const VIBE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['mistral-vibe'],
  rowSessionId: (link) => link.handle.nativeId,
  // Vibe's CLI uses --session-id <uuid> or --resume for last session in folder.
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['--resume'],
      markers: ['--session-id']
    })
}
