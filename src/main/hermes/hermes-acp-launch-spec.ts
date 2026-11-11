import type { AcpLaunchSpec } from '../acp/acp-launch-specs'
import { HERMES_ACP_DIALECT } from '../acp/acp-dialects/hermes-dialect'
import { agentSessionSignInFor } from '../../shared/agent-session/lifecycle/agent-session-sign-in'
import { hermesAcpAccountBinding } from './hermes-acp-account'
import { scrubHermesAcpEnvironment } from './hermes-acp-environment'
import { HERMES_SESSION_HISTORY } from './hermes-session-history'

// `hermes acp --yolo` is rejected; the parent CLI consumes `--yolo` before `acp`.
export const HERMES_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'hermes',
  command: 'hermes',
  args: ({ fullAccess }) => (fullAccess ? ['--yolo', 'acp'] : ['acp']),
  env: {},
  scrubEnvironment: (env, inherited, chosen) => scrubHermesAcpEnvironment(env, inherited, chosen),
  dialect: HERMES_ACP_DIALECT,
  // Orca stays the orchestrator: only an Orca worker is handed this app's CLI and caller identity.
  // Tools run in the Hermes gateway, which may still find an installed `orca` on its own PATH;
  // a profile deny rule for `orca` is what blocks that.
  orcaCliForWorkersOnly: true,
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
