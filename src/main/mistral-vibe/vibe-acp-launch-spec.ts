import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { VIBE_ACP_DIALECT } from '../acp/acp-dialects/vibe-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverVibeInstructions } from '../acp/launch/acp-instructions'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { VIBE_SESSION_HISTORY } from './vibe-session-history'

export const VIBE_ACP_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'mistral-vibe',
  command: 'vibe-acp',
  // Why no launch-line model: `vibe-acp` rejects a --model argument, and its new_session discards
  // extra kwargs, so sessionMeta cannot carry it either. The saved model is applied through the
  // session's own model config option instead (the default path for specs without launchesWithModel).
  args: () => [],
  env: {},
  dialect: VIBE_ACP_DIALECT,
  // Vibe signs in via browser OAuth through Mistral AI Studio; a MISTRAL_API_KEY in the environment
  // authenticates without an ACP authenticate call.
  loginCommand: agentSessionSetupFor('mistral-vibe')?.loginCommand ?? [],
  authMethod: ({ advertised }) => {
    // Only ever answer with an auth method the server advertised; vibe-acp rejects anything else.
    if (advertised.includes('browser-auth')) {
      return 'browser-auth'
    }
    return undefined
  },
  authMethodUnavailableMessage: 'Sign in via Mistral AI Studio or set MISTRAL_API_KEY.',
  account: directoryAccountBinding('VIBE_HOME', (homePath) => join(homePath, '.vibe')),
  // `uv tool install` puts the binaries in ~/.local/bin; the curl install.sh puts them in ~/.vibe/bin.
  installDirectories: ({ homePath }) => [
    join(homePath, '.local', 'bin'),
    join(homePath, '.vibe', 'bin')
  ],
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
  // Vibe's session journal format is not documented; transcript import is off until it is.
  transcriptImport: null,
  sessionHistory: VIBE_SESSION_HISTORY,
  // vibe-acp runs headless and connects only the client's MCP servers, none of its own.
  ownMcpServers: async () => [],
  // Vibe pty launcher uses the unified harness; every session lands in history.
  keepsEverySession: true
}
