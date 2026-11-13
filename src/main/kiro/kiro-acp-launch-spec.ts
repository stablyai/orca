import { homedir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve as resolvePath } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { KIRO_ACP_DIALECT } from '../acp/acp-dialects/kiro-dialect'
import { KIRO_MODEL_LISTING_ARGS, parseKiroModelListing } from './kiro-model-listing'
import type { StructuredAgentSessionHistory } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/agent-session-setup-commands'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/agent-session-account-home'

// Chats cannot adopt Kiro's terminal conversations yet.
const KIRO_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['kiro'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}

const defaultKiroHome = (homePath: string): string => join(homePath, '.kiro')
const KIRO_HOME_BINDING = directoryAccountBinding('KIRO_HOME', defaultKiroHome)

/** kiro-cli 2.31+ ignores a KIRO_HOME at a root or at or above the user's home and uses ~/.kiro. */
function kiroHonorsHome(path: string, homePath: string): boolean {
  const override = resolvePath(path)
  const isRoot = parse(override).root === override
  const homeFromOverride = relative(override, resolvePath(homePath))
  const holdsHome =
    homeFromOverride === '' || (!homeFromOverride.startsWith('..') && !isAbsolute(homeFromOverride))
  return !isRoot && !holdsHome
}

export const KIRO_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'kiro',
  command: 'kiro-cli',
  // The terminal agent's Command setting runs `kiro-cli chat --tui`, which serves no ACP.
  ignoreAgentCommandSetting: true,
  // The default v2 engine speaks another protocol, and v3 rejects the v2 trust flags, so Full access
  // approves each permission request. `--auth-method cli` keeps tokens in `kiro-cli login`'s store.
  args: () => ['acp', '--agent-engine', 'v3', '--auth-method', 'cli'],
  env: {},
  dialect: KIRO_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('kiro')?.loginCommand ?? [],
  // V3 reads settings and sessions from KIRO_HOME but its sign-in from the CLI store. It runs no
  // user hooks here: only clients that opt in at initialize, like the kiro-cli TUI, get them.
  account: {
    ...KIRO_HOME_BINDING,
    // Pin the home Kiro falls back to, so sessions never record one it ignores.
    resolve: async (input) => {
      const home = requireLegacyAgentSessionAccountHome(await KIRO_HOME_BINDING.resolve(input))
      const homePath = homedir()
      return kiroHonorsHome(home.path, homePath)
        ? home
        : { ...home, path: defaultKiroHome(homePath) }
    }
  },
  installDirectories: ({ env, homePath }) => [
    join(homePath, '.local', 'bin'),
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Kiro-Cli')] : [])
  ],
  // Older V3 engines ignore KIRO_HOME and keep sessions in ~/.kiro.
  minimumVersions: ['2.31.0'],
  // The listing's default is the CLI's own; whether a new V3 session runs it is unverified.
  modelDiscovery: {
    kind: 'command',
    args: KIRO_MODEL_LISTING_ARGS,
    parse: parseKiroModelListing,
    listingNamesConfiguredModel: false
  },
  transcriptImport: null,
  sessionHistory: KIRO_SESSION_HISTORY
}
