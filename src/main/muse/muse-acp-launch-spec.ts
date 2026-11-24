import { join } from 'node:path'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'

export const MUSE_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'muse',
  command: 'muse',
  args: () => ['acp'],
  env: {},
  dialect: { clientCapabilities: { elicitation: { form: {} } } },
  loginCommand: agentSessionSetupFor('muse')?.loginCommand ?? [],
  // Pin the session store while keeping Muse's own credential and config discovery.
  account: directoryAccountBinding('XDG_DATA_HOME', (homePath) =>
    join(homePath, '.local', 'share')
  ),
  installDirectories: ({ homePath }) => [join(homePath, '.local', 'bin')],
  minimumVersions: ['1.4.25'],
  permissionModeConfig: { values: { ask: 'promptUnmatched', 'full-access': 'allowAll' } },
  modelDiscovery: {
    kind: 'session',
    listingNamesConfiguredModel: true,
    inPrivateFolder: true,
    sessionFolderArgs: () => ['--no-session-log']
  },
  keepsEverySession: true,
  transcriptImport: null,
  sessionHistory: {
    rowAgents: ['muse'],
    rowSessionId: (link) => link.handle.nativeId,
    parseResumeArgs: (args) =>
      args[0] === 'resume' ? { target: args[1] && !args[1].startsWith('-') ? args[1] : null } : null
  }
}
