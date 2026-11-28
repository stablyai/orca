import * as z from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { GENERIC_ACP_DIALECT } from '../acp/acp-dialects/acp-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import {
  defaultQwenWorkDesktopProfile,
  findQwenWorkDesktopEngine,
  QWENWORK_DESKTOP_PROFILE
} from './qwenwork-desktop-engine'
import { loadWindowsSecurityAsync } from '../../shared/secure-storage/windows-security-addon'

const desktopModelCatalog = lazyZodSchema(() =>
  z.object({
    models: z.array(z.object({ id: z.string(), label: z.string(), isDefault: z.boolean() }))
  })
)

export const QWENWORK_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'qwenwork',
  command: 'QwenWork',
  bundledProgram: async (env) => {
    const program = await findQwenWorkDesktopEngine(env)
    if (!program) {
      throw new AgentSessionPreSpawnError(
        'No compatible QwenWork desktop engine was found on this host.',
        { reason: 'runtimeNotInstalled' }
      )
    }
    // Run our bridge with Orca's Node runtime so vendor runtime fuses and addon ABI do not affect it.
    const launch = { ...program, command: process.execPath }
    if (process.platform === 'win32') {
      const security = await loadWindowsSecurityAsync()
      if ('error' in security || !security.modulePath) {
        throw new AgentSessionPreSpawnError('QwenWork needs Windows credential-file protection.', {
          reason: 'runtimeNotInstalled'
        })
      }
      return { ...launch, prefixArgs: [...launch.prefixArgs, security.modulePath] }
    }
    return launch
  },
  args: () => [],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  dialect: GENERIC_ACP_DIALECT,
  loginCommand: [],
  authMethod: ({ advertised }) => advertised.find((method) => method === 'qwenwork-login'),
  account: directoryAccountBinding(QWENWORK_DESKTOP_PROFILE, defaultQwenWorkDesktopProfile),
  installDirectories: () => [],
  modelDiscovery: {
    kind: 'initialize',
    listingNamesConfiguredModel: true,
    read: async (_initialized, connection) =>
      desktopModelCatalog
        .parse(await connection.requestSessionFreeExtension('_qwenwork/models', {}))
        .models.map((model) => ({ ...model, efforts: [] }))
  },
  keepsEverySession: true,
  transcriptImport: null,
  sessionHistory: {
    rowAgents: [],
    rowSessionId: (link) => link.handle.nativeId,
    parseResumeArgs: () => null
  }
}
