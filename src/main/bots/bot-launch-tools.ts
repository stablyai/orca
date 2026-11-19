// A bot's tools as its agent CLI gets them: a tool with saved headers becomes Orca's relay address plus
// the bot's token, so no saved value reaches the CLI's argv, env or config. The token also names the
// bot to the runtime for its Google commands.
import type { BotToolProblem, BotToolServer } from '../../shared/bot-tools'
import type { BotToolsCli } from './bot-tools-host'
import { botToolRelay, type BotToolRelay } from './tool-relay/bot-tool-relay'
import { BOT_TOOLS_TOKEN_ENV } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1']

/** A bot's servers ready for its CLI; only `BotLaunchTools.for` makes one, so no saved value slips through. */
export class BotLaunchTools {
  static readonly none = new BotLaunchTools([], {}, {}, false)
  // A private member makes the type nominal: a plain object with the same fields isn't one.
  declare private readonly nominal: true

  private constructor(
    readonly servers: readonly BotToolServer[],
    /** Added to the CLI's environment. */
    readonly env: Readonly<Record<string, string>>,
    /** Added to the environment of the commands the CLI runs, not the CLI's own. */
    readonly commandEnv: Readonly<Record<string, string>>,
    /** Some tool goes through the relay, so the CLI must reach loopback directly. */
    readonly relayed: boolean
  ) {}

  /**
   * Every bot launch gets the bot's token: tools present it to the relay, and `orca gmail` and the
   * other Google commands to the runtime, which names the bot by it.
   * Claude reads the token from its env (`${VAR}` in --mcp-config), so argv names only the variable.
   * Codex gets it in the thread config over stdin: Codex saves its env into shell snapshots on disk.
   */
  static async for(
    relay: Pick<BotToolRelay, 'grant'>,
    bot: { botId: string; folder: string; agent: 'claude' | 'codex' },
    servers: readonly BotToolServer[]
  ): Promise<BotLaunchTools> {
    if (servers.some((server) => 'url' in server && Object.keys(server.headers ?? {}).length > 0)) {
      // Header values live in the credential store; one here was never migrated, so it never launches.
      throw new Error('A tool still holds its saved values. Reopen the bot’s tools to move them.')
    }
    const { origin, token } = await relay.grant(bot.botId, bot.folder)
    const tokenEnv = { [BOT_TOOLS_TOKEN_ENV]: token }
    const authorization =
      bot.agent === 'claude' ? `Bearer \${${BOT_TOOLS_TOKEN_ENV}}` : `Bearer ${token}`
    return new BotLaunchTools(
      servers.map((server): BotToolServer => {
        if (!('url' in server) || !server.credential) {
          return server
        }
        return {
          name: server.name,
          url: `${origin}/bot-tools/${server.credential}/mcp`,
          transport: 'http',
          headers: { authorization }
        }
      }),
      bot.agent === 'claude' ? tokenEnv : {},
      bot.agent === 'codex' ? tokenEnv : {},
      servers.some((server) => 'url' in server && server.credential)
    )
  }
}

/** `env` with the tools' additions, and loopback added to both NO_PROXY spellings when needed. */
export function withBotLaunchToolsEnv(
  env: Record<string, string>,
  tools: BotLaunchTools
): Record<string, string> {
  if (!tools.relayed) {
    return Object.keys(tools.env).length > 0 ? { ...env, ...tools.env } : env
  }
  // Both CLIs send loopback calls into HTTP(S)_PROXY unless NO_PROXY names loopback.
  const existing = [env.NO_PROXY, env.no_proxy]
    .flatMap((value) => (value ?? '').split(','))
    .map((entry) => entry.trim())
    .filter(Boolean)
  const noProxy = [...new Set([...existing, ...LOOPBACK_HOSTS])].join(',')
  return { ...env, ...tools.env, NO_PROXY: noProxy, no_proxy: noProxy }
}

/** The bot's servers as its CLI gets them for a turn, and the CLI with the env that goes with them. */
export async function cliWithLaunchTools(
  cli: BotToolsCli,
  servers: readonly BotToolServer[]
): Promise<{ cli: BotToolsCli; tools: BotLaunchTools }> {
  const tools = await BotLaunchTools.for(
    botToolRelay,
    { botId: cli.botId, folder: cli.folder, agent: cli.agent },
    servers
  )
  return { cli: { ...cli, env: withBotLaunchToolsEnv(cli.env, tools) }, tools }
}

/** A relayed tool's server that refused its saved values says so on the row. */
export function withRelayProblems(
  cli: BotToolsCli,
  servers: readonly BotToolServer[],
  problems: Record<string, BotToolProblem>
): Record<string, BotToolProblem> {
  const out = { ...problems }
  for (const server of servers) {
    const detail =
      'url' in server && server.credential
        ? botToolRelay.lastProblem(cli.folder, server.credential)
        : null
    if (detail && out[server.name]) {
      out[server.name] = { kind: 'failed', detail }
    }
  }
  return out
}
