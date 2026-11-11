import type { AcpLaunchSpec } from '../acp/acp-launch-specs'
import { HERMES_ACP_DIALECT } from '../acp/acp-dialects/hermes-dialect'
import { agentSessionSignInFor } from '../../shared/agent-session/lifecycle/agent-session-sign-in'
import { hermesAcpAccountBinding } from './hermes-acp-account'
import { HERMES_SESSION_HISTORY } from './hermes-session-history'

export const HERMES_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'hermes',
  command: 'hermes',
  // No --yolo: Hermes freezes it into the session it creates, so a chat switched back to asking
  // would keep skipping approvals. Full access approves each request in Orca instead.
  args: () => ['acp'],
  env: {},
  dialect: HERMES_ACP_DIALECT,
  loginCommand: agentSessionSignInFor('hermes')?.loginCommand ?? [],
  // `hermes-setup` is interactive and authenticates only after credentials exist.
  authMethod: ({ advertised }) => advertised.find((id) => id !== 'hermes-setup'),
  account: hermesAcpAccountBinding(),
  installDirectories: () => [],
  // Replay frames carry no turn id, so catch-up would fail the attach. Journals reopen themselves.
  compaction: true,
  modelDiscovery: {
    kind: 'unavailable',
    reason: 'Hermes lists its models only in a chat session'
  },
  // Sessions live in SQLite, not transcript files.
  transcriptImport: null,
  sessionHistory: HERMES_SESSION_HISTORY
}
