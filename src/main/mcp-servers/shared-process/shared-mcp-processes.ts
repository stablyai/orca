// The host's shared command servers, as the relay reaches them: each runs while some agent session
// uses it, starts again when its command, args or env change, and stops once nothing uses it, it
// stops being shared, or it's removed. Checked against the host list on every request, so an edit
// made anywhere (another client, a plugin sync, the file itself) applies on the next one.
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dropInheritedOrcaIdentityEnv } from '../../ipc/pty/host-env/inherited-orca-identity-env'
import { resolveCommandOnLocalPath } from '../../ipc/command-path/command-path-resolver'
import {
  hostShellEnvironment,
  structuredAgentBaseEnvironment
} from '../../runtime/agent-session/environment/structured-agent-shell-environment'
import { overlayEnvironmentVariables } from '../../../shared/shell/launch/environment-overlay'
import { RelayRefusal } from '../../bots/tool-relay/bot-tool-relay-requests'
import { answerUnavailable } from '../../bots/tool-relay/bot-tool-relay-sign-in-answer'
import { sharedMcpProcessServers, type McpCommandServer } from '../mcp-shared-process-servers'
import { isMcpServersFeatureEnabled } from '../mcp-servers-feature'
import { answerNoSession, answerParseError, answerSessionGone } from './shared-mcp-http-answers'
import type { isInitializeRequest as IsInitializeRequestFn } from '@modelcontextprotocol/sdk/types.js'
import type { SharedMcpLaunch, SharedMcpProcess, SharedMcpStartFailed } from './shared-mcp-process'

type SharedMcpRuntimeModules = {
  isInitializeRequest: typeof IsInitializeRequestFn
  SharedMcpProcess: typeof SharedMcpProcess
  SharedMcpStartFailed: typeof SharedMcpStartFailed
}
let runtimeModulesLoader: Promise<SharedMcpRuntimeModules> | null = null

function loadSharedMcpRuntimeModules(): Promise<SharedMcpRuntimeModules> {
  runtimeModulesLoader ??= Promise.all([
    import('@modelcontextprotocol/sdk/types.js'),
    import('./shared-mcp-process')
  ])
    .then(([{ isInitializeRequest }, { SharedMcpProcess, SharedMcpStartFailed }]) => ({
      isInitializeRequest,
      SharedMcpProcess,
      SharedMcpStartFailed
    }))
    .catch((error: unknown) => {
      runtimeModulesLoader = null
      throw error
    })
  return runtimeModulesLoader
}

/** A start that failed is answered as failed for this long, so agents retrying can't spawn in a loop. */
const FAILED_START_MS = 10_000
/** How long a new child waits for the one it replaces to exit (its port, its lock), at most. */
const REPLACED_EXIT_MS = 5_000

/** What the relay hands its requests for a shared server to. */
export type RelayProcesses = Pick<SharedMcpProcesses, 'handle' | 'close'>

/** One agent request for the shared server `serverId` in the host list kept in `folder`. */
export type SharedMcpProcessRequest = {
  folder: string
  serverId: string
  req: IncomingMessage
  res: ServerResponse
  /** The POST body, already read. */
  body: Buffer | undefined
  /** The relay's cut: the token was revoked, or the relay closed. */
  signal?: AbortSignal
}

/** Where the server comes from and how its launch is built: the host list and the login shell. */
type Deps = {
  /** The list's shared command servers, by id. */
  servers: (folder: string) => Promise<ReadonlyMap<string, McpCommandServer>>
  prepare: (server: McpCommandServer) => Promise<SharedMcpLaunch>
}

const fingerprintOf = (server: McpCommandServer): string =>
  createHash('sha256')
    .update(JSON.stringify([server.command, server.args, server.env ?? {}]))
    .digest('hex')

/** The user's login-shell environment with the server's own env over it, run from the home folder. */
async function prepareLaunch(server: McpCommandServer): Promise<SharedMcpLaunch> {
  const env = structuredAgentBaseEnvironment({
    shellEnv: await hostShellEnvironment(),
    policy: { inheritAll: true, names: [] }
  })
  // It serves every session, so it carries none's identity.
  dropInheritedOrcaIdentityEnv(env)
  // Case-insensitive on Windows, so the server's `Path` replaces the shell's `PATH`.
  const withServer = overlayEnvironmentVariables(env, server.env ?? {}, process.platform)
  const cwd = homedir()
  // A relative path (`./bin/server`) is from the home folder it runs in, as an agent's is from its workspace.
  const command =
    isAbsolute(server.command) || !/[\\/]/.test(server.command)
      ? server.command
      : resolvePath(cwd, server.command)
  const program = await resolveCommandOnLocalPath(command, { env: withServer, cwd })
  if (!program) {
    throw new Error(`${server.command} wasn’t found on this computer`)
  }
  return { program, args: server.args, env: withServer, cwd }
}

export class SharedMcpProcesses {
  private readonly running = new Map<string, SharedMcpProcess>()
  /** A server's failed start while its window lasts, which removes it. */
  private readonly failed = new Map<string, { fingerprint: string; expiry: NodeJS.Timeout }>()
  /** A stopped child's exit, which the next child of that server waits for. */
  private readonly exiting = new Map<string, Promise<void>>()
  private readonly deps: Deps

  constructor(deps: Partial<Deps> = {}) {
    this.deps = {
      servers: sharedMcpProcessServers,
      prepare: prepareLaunch,
      ...deps
    }
  }

  async handle(request: SharedMcpProcessRequest): Promise<void> {
    if (!isMcpServersFeatureEnabled()) {
      throw new RelayRefusal(404, 'Not found.')
    }
    const { req, res, body, signal } = request
    // A deleted bot's token, or the relay closing, cuts its open calls and streams here too.
    const cut = (): void => void res.destroy()
    // One revoked while the relay read its body never reaches the child.
    signal?.throwIfAborted()
    signal?.addEventListener('abort', cut, { once: true })
    try {
      const parsed = body === undefined ? undefined : parseJson(body)
      if (parsed === INVALID) {
        answerParseError(res)
        return
      }
      // An initialize whose child stopped while it waited gets one more try, with a new child.
      for (let tries = 0; tries < 2; tries += 1) {
        if (await this.handleOnce(request, parsed)) {
          return
        }
      }
      answerUnavailable(req, res, body)
    } finally {
      signal?.removeEventListener('abort', cut)
    }
  }

  /** False when the child stopped before it could answer an initialize. */
  private async handleOnce(
    { folder, serverId, req, res, body }: SharedMcpProcessRequest,
    parsed: unknown
  ): Promise<boolean> {
    const key = `${folder}\0${serverId}`
    const server = (await this.deps.servers(folder)).get(serverId)
    if (!server) {
      this.running.get(key)?.stop()
      throw new RelayRefusal(404, 'This server isn’t shared on this computer any more.')
    }
    const { isInitializeRequest, SharedMcpProcess, SharedMcpStartFailed } =
      await loadSharedMcpRuntimeModules()
    // Read after the last await before start(), so concurrent first initializes share one child.
    let process = this.running.get(key)
    const fingerprint = fingerprintOf(server)
    if (process && process.fingerprint !== fingerprint) {
      process.stop()
      process = undefined
    }
    if (!process) {
      // A session from a child that stopped, or ran an older command: its agent starts over.
      if (req.headers['mcp-session-id'] !== undefined) {
        answerSessionGone(res)
        return true
      }
      if (req.method !== 'POST' || !isInitializeRequest(parsed)) {
        answerNoSession(res)
        return true
      }
      const failed = this.failed.get(key)
      if (failed?.fingerprint === fingerprint) {
        answerUnavailable(req, res, body)
        return true
      }
      process = this.start(key, server, fingerprint, SharedMcpProcess)
    }
    try {
      return await process.handle(req, res, parsed)
    } catch (error) {
      if (error instanceof SharedMcpStartFailed) {
        // Every agent waiting on that start lands here; the first records it. One a newer start
        // replaced (its command changed) failed nothing, so it can't hide that start's failure.
        const latest = this.running.get(key)
        if (!this.failed.has(key) && (latest === undefined || latest === process)) {
          console.warn(`[mcp-servers] ${server.name}'s shared process couldn’t start`, error.reason)
          this.recordFailedStart(key, fingerprint)
        }
      }
      if (res.headersSent) {
        res.destroy()
      } else {
        answerUnavailable(req, res, body)
      }
      return true
    }
  }

  /** Stops the children of servers in `folder` that are gone, no longer shared or changed. */
  async reconcile(folder: string): Promise<void> {
    const prefix = `${folder}\0`
    if (![...this.running.keys()].some((key) => key.startsWith(prefix))) {
      return
    }
    const servers = await this.deps.servers(folder).catch(() => null)
    for (const [key, process] of this.running) {
      if (!key.startsWith(prefix)) {
        continue
      }
      const server = servers?.get(key.slice(prefix.length))
      if (!server || fingerprintOf(server) !== process.fingerprint) {
        process.stop()
      }
    }
  }

  /** Orca is quitting: every child is killed now. */
  close(): void {
    for (const process of this.running.values()) {
      process.stop(true)
    }
    this.running.clear()
    for (const key of this.failed.keys()) {
      this.clearFailedStart(key)
    }
  }

  private recordFailedStart(key: string, fingerprint: string): void {
    const expiry = setTimeout(() => this.failed.delete(key), FAILED_START_MS)
    expiry.unref()
    this.failed.set(key, { fingerprint, expiry })
  }

  private clearFailedStart(key: string): void {
    clearTimeout(this.failed.get(key)?.expiry)
    this.failed.delete(key)
  }

  private start(
    key: string,
    server: McpCommandServer,
    fingerprint: string,
    ProcessClass: typeof SharedMcpProcess
  ): SharedMcpProcess {
    this.clearFailedStart(key)
    const process = new ProcessClass(
      server.name,
      fingerprint,
      async () => {
        await this.exiting.get(key)
        return this.deps.prepare(server)
      },
      (stopped) => {
        if (this.running.get(key) === stopped) {
          this.running.delete(key)
        }
        const exit = Promise.race([stopped.exited, delay(REPLACED_EXIT_MS)])
        this.exiting.set(key, exit)
        void exit.then(() => {
          if (this.exiting.get(key) === exit) {
            this.exiting.delete(key)
          }
        })
      }
    )
    this.running.set(key, process)
    return process
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref())

const INVALID = Symbol('invalid JSON')

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return INVALID
  }
}

/** The shared children for this process's relay. */
export const sharedMcpProcesses = new SharedMcpProcesses()
