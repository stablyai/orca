// A session's MCP servers as its agent CLI gets them: a bot's own tools and the host list's servers.
// A server with saved headers or Orca's own sign-in becomes Orca's relay address plus a token, so no
// saved value reaches the CLI's argv, env or config, and so does a command server Orca runs once for
// every session. A bot's token also names the bot to the runtime.
import { BotFailureError } from '../../shared/bots/bot-failure-copy'
import type { BotToolServer } from '../../shared/bot-tools'
import {
  BOT_TOOLS_TOKEN_ENV,
  MCP_TOKEN_ENV
} from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import {
  MCP_HOST_LIST_RELAY_OWNER,
  relayToolUrl,
  type BotToolRelay,
  type RelayFolders
} from '../bots/tool-relay/bot-tool-relay'
import { relayProcessUrl } from '../bots/tool-relay/bot-tool-relay-grants'

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1']

/** A bot's session, whose own tools and token come from its home folder; null for any other session. */
export type SessionMcpBot = { botId: string; folder: string } | null

/** The host list's servers a session gets, from the list kept in `folder`. */
export type SessionHostMcpServers = {
  folder: string
  servers: readonly BotToolServer[]
  /** The command servers among them Orca runs once on the host, by name to their id. */
  sharedProcesses?: ReadonlyMap<string, string>
}

const relayed = (server: BotToolServer): server is BotToolServer & { credential: string } =>
  'url' in server && server.credential !== undefined

/** A session's servers ready for its CLI; only `SessionMcpTools.for` makes one, so no saved value slips through. */
export class SessionMcpTools {
  static readonly none = new SessionMcpTools([], {}, {}, false, new Set())
  // A private member makes the type nominal: a plain object with the same fields isn't one.
  declare private readonly nominal: true

  private constructor(
    readonly servers: readonly BotToolServer[],
    /** Added to the CLI's environment. */
    readonly env: Readonly<Record<string, string>>,
    /** Added to the environment of the commands the CLI runs, not the CLI's own. */
    readonly commandEnv: Readonly<Record<string, string>>,
    /** Some server goes through the relay, so the CLI must reach loopback directly. */
    readonly relayed: boolean,
    /** Which of `servers` came from the host's list, which the `/mcp` tray shows as Orca's. */
    readonly hostNames: ReadonlySet<string>
  ) {}

  /**
   * A bot's launch always gets its token, whichever agent runs it: its tools present it to the
   * relay, and the `orca` calls the session makes name the bot by it. Any other session gets the
   * host's token, which names no bot, and only when one of its servers goes through the relay. On
   * a shared name the bot's own server wins over the host list's. A terminal's launch (`terminal`)
   * always names the token by its variable and carries it in env: its argv lands in shell history.
   */
  static async for(
    relay: Pick<BotToolRelay, 'grant'>,
    launch: { bot: SessionMcpBot; agent: string; terminal?: boolean },
    sources: { own?: readonly BotToolServer[]; host?: SessionHostMcpServers | undefined }
  ): Promise<SessionMcpTools> {
    const own = sources.own ?? []
    const ownNames = new Set(own.map((server) => server.name))
    const host = (sources.host?.servers ?? []).filter((server) => !ownNames.has(server.name))
    if ([...own, ...host].some((server) => 'url' in server && hasHeaders(server))) {
      // Header values live in the credential store; one here was never migrated, so it never launches.
      throw new BotFailureError('toolValuesUnmoved')
    }
    const sharedProcesses = sources.host?.sharedProcesses ?? new Map<string, string>()
    const sharedId = (server: BotToolServer): string | undefined =>
      'url' in server ? undefined : sharedProcesses.get(server.name)
    const hostRelayed = host.some((server) => relayed(server) || sharedId(server) !== undefined)
    if (!launch.bot && !hostRelayed) {
      return host.length === 0
        ? SessionMcpTools.none
        : new SessionMcpTools(host, {}, {}, false, new Set(host.map((server) => server.name)))
    }
    // A bot that takes the host list keeps its reach to it even while none of its servers is relayed.
    const folders: RelayFolders = {
      ...(launch.bot ? { bot: launch.bot.folder } : {}),
      ...(sources.host ? { host: sources.host.folder } : {})
    }
    const { origin, token } = await relay.grant(
      launch.bot?.botId ?? MCP_HOST_LIST_RELAY_OWNER,
      folders
    )
    const tokenName = launch.bot ? BOT_TOOLS_TOKEN_ENV : MCP_TOKEN_ENV
    // Claude and Pi expand `${VAR}` in a server's headers, so their config names only the variable.
    const referencesEnv = launch.terminal === true || ENV_REFERENCING_AGENTS.has(launch.agent)
    // A bot's token also names it to the runtime; the host's only opens servers, so an agent whose
    // config carries it outright never gets it in env, where every command it runs would see it.
    const tokenEnv = launch.bot || referencesEnv ? { [tokenName]: token } : {}
    const authorization = referencesEnv ? `Bearer \${${tokenName}}` : `Bearer ${token}`
    const viaRelay = (server: BotToolServer, url: string): BotToolServer => ({
      name: server.name,
      url,
      transport: 'http',
      headers: { authorization }
    })
    const throughRelay =
      (scope: keyof RelayFolders) =>
      (server: BotToolServer): BotToolServer => {
        if (relayed(server)) {
          return viaRelay(server, relayToolUrl(origin, scope, server.credential))
        }
        const process = scope === 'host' ? sharedId(server) : undefined
        return process === undefined ? server : viaRelay(server, relayProcessUrl(origin, process))
      }
    // Codex saves its own env into shell snapshots on disk, so only the commands it runs get the token.
    const commandsOnly = launch.agent === 'codex' && launch.terminal !== true
    return new SessionMcpTools(
      [...own.map(throughRelay('bot')), ...host.map(throughRelay('host'))],
      commandsOnly ? {} : tokenEnv,
      commandsOnly ? tokenEnv : {},
      own.some(relayed) || hostRelayed,
      new Set(host.map((server) => server.name))
    )
  }

  /**
   * Without the host list's servers named like one of the agent's own (`taken`), which would merge
   * into or shadow it; the agent's own server runs instead. A bot's own servers are kept.
   */
  beside(taken: Iterable<string>): { tools: SessionMcpTools; skipped: string[] } {
    const names = new Set(taken)
    const skipped = [...this.hostNames].filter((name) => names.has(name))
    if (skipped.length === 0) {
      return { tools: this, skipped }
    }
    return {
      tools: new SessionMcpTools(
        this.servers.filter((server) => !skipped.includes(server.name)),
        this.env,
        this.commandEnv,
        this.relayed,
        new Set([...this.hostNames].filter((name) => !names.has(name)))
      ),
      skipped
    }
  }
}

const hasHeaders = (server: BotToolServer): boolean =>
  'url' in server && Object.keys(server.headers ?? {}).length > 0

const ENV_REFERENCING_AGENTS: ReadonlySet<string> = new Set(['claude', 'pi'])

/** `env` with the tools' additions, and loopback added to both NO_PROXY spellings when needed. */
export function withSessionMcpToolsEnv(
  env: Record<string, string>,
  tools: SessionMcpTools
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
