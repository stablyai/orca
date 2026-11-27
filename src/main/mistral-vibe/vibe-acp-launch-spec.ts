import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { VIBE_ACP_DIALECT } from '../acp/acp-dialects/vibe-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverVibeInstructions } from '../acp/launch/acp-instructions'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { VIBE_SESSION_HISTORY } from './vibe-session-history'
import { VIBE_TRANSCRIPT_IMPORT } from './vibe-transcript-import'

export const VIBE_ACP_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'mistral-vibe',
  command: 'vibe-acp',
  // Model selection: vibe-acp accepts a --model alias on new_session via ACP's sessionMeta.
  // Orca passes it through sessionMeta; the ACP server reads it on session creation.
  args: () => [],
  env: {},
  // Vibe-acp launches with a model option that names its alias (mistral-large, mistral-small, etc.).
  launchesWithModel: true,
  dialect: VIBE_ACP_DIALECT,
  // Vibe uses browser OAuth sign-in via Mistral AI Studio, plus an optional API key.
  loginCommand: agentSessionSetupFor('mistral-vibe')?.loginCommand ?? [],
  authMethod: ({ advertised, env }) => {
    // vibe-acp advertises `browser-auth` in initialize. It also accepts MISTRAL_API_KEY.
    if (advertised.includes('browser-auth') && !env.MISTRAL_API_KEY) {
      return 'browser-auth'
    }
    if (env.MISTRAL_API_KEY) {
      return 'mistral.api_key'
    }
    return undefined
  },
  authMethodUnavailableMessage: 'Sign in via Mistral AI Studio or set MISTRAL_API_KEY.',
  account: directoryAccountBinding('VIBE_HOME', (homePath) => join(homePath, '.vibe')),
  installDirectories: ({ homePath }) => [join(homePath, '.vibe', 'bin')],
  minimumVersions: ['3.1.0'],
  // Vibe has its own permission modes; map Orca's modes to vibe's.
  // vibe-acp modes: ask, accept-edits, smart-approve, auto-approve
  // Orca modes: ask, accept-edits, auto, full-access
  permissionModeConfig: {
    values: {
      ask: 'ask',
      'accept-edits': 'accept-edits',
      auto: 'smart-approve',
      'full-access': 'auto-approve'
    }
  },
  // Model discovery: vibe-acp does not expose a standalone models endpoint.
  // We list via a disposable session (same as Claude/Codex v1).
  modelDiscovery: { kind: 'session', listingNamesConfiguredModel: false },
  instructions: deliverVibeInstructions,
  compaction: true,
  compactionInstructions: true,
  transcriptImport: VIBE_TRANSCRIPT_IMPORT,
  sessionHistory: VIBE_SESSION_HISTORY,
  // Vibe-acp starts the app-server in headless mode; no terminal.
  // No own MCP servers for vibe-acp
  ownMcpServers: async () => [],
  // Vibe pty launcher uses the unified harness; every session lands in history.
  keepsEverySession: true
}
