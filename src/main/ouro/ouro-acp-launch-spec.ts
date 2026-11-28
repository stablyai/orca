import { join } from 'node:path'
import { z } from 'zod'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import type { AcpAccountBinding } from '../acp/launch/acp-account-binding'
import { GENERIC_ACP_DIALECT } from '../acp/acp-dialects/acp-dialect'
import { resolveStructuredEnvAccountHomePath } from '../runtime/agent-session/environment/structured-agent-account-home'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { AgentSessionModelOption } from '../../shared/agent-session/options/model-catalog/agent-session-model-option'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { StructuredAgentSessionHistory } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Ouro's daemon serves every agent on this machine; `ouro status --json` lists them.
const OuroStatusSchema = z.object({
  agents: z.array(z.unknown())
})
// With no daemon to ask, `ouro status --json` still exits 0, and says why in its own output.
const OuroStatusFailureSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1)
})
const OuroStatusAgentSchema = z.object({
  name: z.string().min(1),
  enabled: z.literal(true),
  // An agent whose home is another machine runs there, and this daemon won't serve it. A
  // fallback agent has no reachable home and runs here until it has one.
  homeState: z.enum(['here', 'fallback'])
})

/** The agents this machine's daemon serves, as the chat's models: the model is the agent. */
export function parseOuroAgentListing(stdout: string): AgentSessionModelOption[] {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return []
  }
  const failure = OuroStatusFailureSchema.safeParse(json)
  if (failure.success) {
    throw new Error(`ouro status: ${failure.data.error}. Run \`ouro up\` to start the daemon.`)
  }
  const status = OuroStatusSchema.safeParse(json)
  if (!status.success) {
    return []
  }
  return status.data.agents.flatMap((row) => {
    const agent = OuroStatusAgentSchema.safeParse(row)
    if (!agent.success) {
      return []
    }
    const { name } = agent.data
    return [
      {
        id: name,
        label: name.charAt(0).toUpperCase() + name.slice(1),
        isDefault: false,
        efforts: []
      }
    ]
  })
}

// Ouro keeps no account folder and reads no variable for one: its daemon owns every agent's state
// under ~/AgentBundles. As with Goose, the pin only names that store for Orca, and the
// environment is left as it is. OURO_AGENT_BUNDLES is Orca's key for it; Ouro never reads it.
const OURO_ACCOUNT_VARIABLE = 'OURO_AGENT_BUNDLES'
const OURO_ACCOUNT: AcpAccountBinding = {
  pin: { accountHomeVariable: OURO_ACCOUNT_VARIABLE },
  resolve: async ({ launchEnv }) => ({
    variable: OURO_ACCOUNT_VARIABLE,
    path: resolveStructuredEnvAccountHomePath({
      launchEnv,
      variable: OURO_ACCOUNT_VARIABLE,
      defaultPath: (homePath) => join(homePath, 'AgentBundles')
    })
  }),
  environment: (home, env) => {
    if (!isLegacyAgentSessionAccountHome(home) || home.variable !== OURO_ACCOUNT_VARIABLE) {
      throw new Error(`sessions of this agent pin ${OURO_ACCOUNT_VARIABLE}`)
    }
    return env
  }
}

// Session History has no rows for Ouro's sessions, so no row or terminal resume maps to a chat.
const OURO_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: [],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}

export const OURO_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'ouro',
  command: 'ouro',
  // The chat's model is the Ouro agent it talks to. With none picked, `acp-serve` is left to
  // choose, and today it refuses with "acp-serve requires --agent <name>", which the chat shows.
  args: ({ model }) => (model ? ['acp-serve', '--agent', model] : ['acp-serve']),
  launchesWithModel: true,
  // A reopened chat is still the same agent's; without it acp-serve could not start.
  reopensWithModel: true,
  env: {},
  dialect: GENERIC_ACP_DIALECT,
  // The daemon signs its agents in itself; ACP advertises no sign-in.
  loginCommand: agentSessionSetupFor('ouro')?.loginCommand ?? [],
  account: OURO_ACCOUNT,
  // The `ouro` launcher that `npx ouro.bot` installs.
  installDirectories: ({ homePath }) => [join(homePath, '.ouro-cli', 'bin')],
  // The first release that advertises loadSession, so saved chats reopen.
  minimumVersions: ['0.1.0-alpha.1632'],
  // Each agent names itself, so no listing names one as the default: an unpicked chat runs none.
  modelDiscovery: {
    kind: 'command',
    args: ['status', '--json'],
    parse: parseOuroAgentListing,
    listingNamesConfiguredModel: false
  },
  // Its ACP server ignores `session/new` mcpServers.
  botToolsOff: "Ouro doesn't load the tools Orca passes to its chats",
  // No `instructions`: an Ouro agent keeps its own system prompt, and acp-serve takes none. Plain
  // chats pass no standing instructions, so they start; a bot's chat would not, so bots don't run here.
  transcriptImport: null,
  sessionHistory: OURO_SESSION_HISTORY,
  // No session/delete, and the agent is a live one: Orca never sends it a naming or listing prompt.
  keepsEverySession: true
}
