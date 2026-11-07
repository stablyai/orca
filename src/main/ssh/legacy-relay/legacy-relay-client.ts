/** Drive only already-listening legacy relays using their own relay.js --connect and matching bundle hash; deploy/start nothing. COMPAT(legacy-relay-bridge): revisit 2027-01-15. */
import { z } from 'zod'
import type { MultiplexerTransport } from '../ssh-channel-multiplexer'
import { SshChannelMultiplexer } from '../ssh-channel-multiplexer'

const PROTOCOL_VERSION = 1
const OPEN_CLIENT_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 15_000
// The relay's owner-claim errors (v1.4.2xx `pty-consumer-session-contract.ts`).
const OWNER_RECOVERY_PENDING = -32042
const OWNER_RECOVERY_SUPERSEDED = -32043
const OWNER_HELD_ATTACHED = -32044
const OWNER_HELD_DISCONNECTED = -32045
const OWNER_HELD_SELF = -32046
const METHOD_NOT_FOUND = -32601
// Longer than the relay's 30s owner grace, which a different client clamps to 250ms on asking.
const OWNER_RETRY_BUDGET_MS = 35_000

export const REMOTE_CLI_UNAVAILABLE =
  'This terminal was started by an older version of Orca, so orca commands are unavailable ' +
  'in it. Run them in a new terminal on this host.'

export type LegacyRelayOwnerClaim = { ownerGeneration: number; ownerLease: string }

/** Serves the `orca` commands run inside the old relay's terminals; params are the host's. */
export type LegacyRelayCliServer = {
  /** `signal` aborts when this client's connection closes, so a waiting check stops with it. */
  cli: (params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
  postOutput: (params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
}

type LegacyRelayClientOptions = {
  clientInstanceId: string
  /** A claim this client held before a drop, so the owner role resumes without waiting. */
  resume?: LegacyRelayOwnerClaim | null
  /** Runs the relay's own `relay.js --connect` and hands back the stream after its sentinel. */
  openTransport: () => Promise<MultiplexerTransport>
  /** Test seam for the owner-claim retry wait. */
  sleep?: (ms: number) => Promise<void>
  /** Absent: every relay-era `orca` command is refused with REMOTE_CLI_UNAVAILABLE. */
  cliServer?: LegacyRelayCliServer
}

/** Another client holds this relay's terminals while attached; never displaced. */
export class LegacyRelayOwnerHeldError extends Error {
  readonly code = 'legacy_relay_owner_held'
  constructor() {
    super('Another Orca client is attached to this relay')
  }
}

export type LegacyRelayPty = {
  relayPtyId: string
  cwd?: string
  title?: string
  worktreeId?: string
  /** The relay's own claims about the process; the bridge checks them against desktop records. */
  incarnationId?: string
  terminalHandle?: string
}

type DataListener = (relayPtyId: string, data: string) => void
type ExitListener = (relayPtyId: string, code: number) => void

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

// Any build's grant is accepted: the bridge talks to whichever relay is already there.
const OwnerGrantSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  role: z.literal('session-owner'),
  ownerGeneration: z.number().int().positive(),
  ownerLease: z.string().min(1).max(512)
})

const PtyRowSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().optional().catch(undefined),
  title: z.string().optional().catch(undefined),
  worktreeId: z.string().optional().catch(undefined),
  incarnationId: z.string().min(1).max(512).optional().catch(undefined),
  terminalHandle: z.string().min(1).max(512).optional().catch(undefined)
})

const AttachResultSchema = z.object({ replay: z.string().optional().catch(undefined) }).nullable()

function replayOf(result: unknown): string {
  const parsed = AttachResultSchema.safeParse(result)
  return (parsed.success ? parsed.data?.replay : undefined) ?? ''
}

function parseOwnerGrant(value: unknown): LegacyRelayOwnerClaim {
  const grant = OwnerGrantSchema.safeParse(value)
  if (!grant.success) {
    throw new Error('Older relay did not grant the terminal owner role')
  }
  return { ownerGeneration: grant.data.ownerGeneration, ownerLease: grant.data.ownerLease }
}

function parsePtyList(value: unknown): LegacyRelayPty[] {
  if (!Array.isArray(value)) {
    throw new Error('Older relay answered pty.listProcesses with something other than a list')
  }
  return value.flatMap((row: unknown) => {
    const parsed = PtyRowSchema.safeParse(row)
    if (!parsed.success) {
      return []
    }
    const { id, cwd, title, worktreeId, incarnationId, terminalHandle } = parsed.data
    return [
      {
        relayPtyId: id,
        ...(cwd === undefined ? {} : { cwd }),
        ...(title === undefined ? {} : { title }),
        ...(worktreeId === undefined ? {} : { worktreeId }),
        ...(incarnationId === undefined ? {} : { incarnationId }),
        ...(terminalHandle === undefined ? {} : { terminalHandle })
      }
    ]
  })
}

export class LegacyRelayClient {
  private readonly dataListeners = new Set<DataListener>()
  private readonly exitListeners = new Set<ExitListener>()
  private readonly closeListeners = new Set<() => void>()

  private constructor(
    private readonly mux: SshChannelMultiplexer,
    /** Null for a relay that predates owner claims (it serves any client). */
    readonly ownerClaim: LegacyRelayOwnerClaim | null,
    cliServer: LegacyRelayCliServer | undefined
  ) {
    mux.onNotification((method, params) => this.route(method, params))
    // The old relay forwards `orca` commands run inside its terminals to its attached client;
    // without a server this says why instead of "Method not found".
    const closed = new AbortController()
    mux.onRequest('orca.cli', (params) =>
      cliServer
        ? cliServer.cli(params, closed.signal)
        : Promise.reject(new Error(REMOTE_CLI_UNAVAILABLE))
    )
    mux.onRequest('orca.cli.postOutput', (params) =>
      cliServer
        ? cliServer.postOutput(params, closed.signal)
        : Promise.reject(new Error(REMOTE_CLI_UNAVAILABLE))
    )
    mux.onDispose(() => {
      closed.abort()
      this.closeListeners.forEach((listener) => listener())
    })
  }

  static async open(options: LegacyRelayClientOptions): Promise<LegacyRelayClient> {
    const mux = new SshChannelMultiplexer(await options.openTransport())
    try {
      const claim = await claimOwner(mux, options)
      return new LegacyRelayClient(mux, claim, options.cliServer)
    } catch (error) {
      mux.dispose()
      throw error
    }
  }

  get closed(): boolean {
    return this.mux.isDisposed()
  }

  async list(): Promise<LegacyRelayPty[]> {
    return parsePtyList(
      await this.mux.request(
        'pty.listProcesses',
        { includeForegroundProcessEvidence: false },
        { timeoutMs: REQUEST_TIMEOUT_MS }
      )
    )
  }

  /** atSnapshot runs in stream order: earlier output is in the returned screen, later output is not. */
  async attach(
    relayPtyId: string,
    atSnapshot?: (replay: string) => void
  ): Promise<{ replay: string }> {
    const result = await this.mux.request(
      'pty.attach',
      { id: relayPtyId, suppressReplayNotification: true, requireReplay: true },
      {
        timeoutMs: REQUEST_TIMEOUT_MS,
        ...(atSnapshot ? { beforeResolve: (value: unknown) => atSnapshot(replayOf(value)) } : {})
      }
    )
    return { replay: replayOf(result) }
  }

  write(relayPtyId: string, data: string): void {
    this.mux.notify('pty.data', { id: relayPtyId, data })
  }

  resize(relayPtyId: string, cols: number, rows: number): void {
    this.mux.notify('pty.resize', { id: relayPtyId, cols, rows })
  }

  /** Use the legacy shutdown wire shape; omit unsupported incarnation fields entirely for older relays. */
  async shutdown(relayPtyId: string, expectedIncarnationId?: string): Promise<void> {
    await this.mux.request(
      'pty.shutdown',
      {
        id: relayPtyId,
        immediate: false,
        keepHistory: false,
        ...(expectedIncarnationId ? { expectedIncarnationId } : {})
      },
      { timeoutMs: REQUEST_TIMEOUT_MS }
    )
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  /** Hangs up this client only; the relay keeps every terminal and its own grace decides the rest. */
  close(): void {
    this.mux.dispose()
  }

  private route(method: string, params: Record<string, unknown>): void {
    const id = params.id
    if (typeof id !== 'string' || id.length === 0) {
      return
    }
    if (method === 'pty.data' && typeof params.data === 'string') {
      const data = params.data
      this.dataListeners.forEach((listener) => listener(id, data))
    } else if (method === 'pty.exit') {
      const code = typeof params.code === 'number' ? params.code : -1
      this.exitListeners.forEach((listener) => listener(id, code))
    }
  }
}

/** Request ownership without flow control so old relays emit plain unacknowledged pty.data. Never displace attached holders. */
async function claimOwner(
  mux: SshChannelMultiplexer,
  options: LegacyRelayClientOptions
): Promise<LegacyRelayOwnerClaim | null> {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deadline = Date.now() + OWNER_RETRY_BUDGET_MS
  let delayMs = 25
  let resume = options.resume ?? null
  for (;;) {
    try {
      const grant = await mux.request(
        'pty.openClient',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientInstanceId: options.clientInstanceId,
          requestedRole: 'session-owner',
          ...(resume ? { resume } : {})
        },
        { timeoutMs: OPEN_CLIENT_TIMEOUT_MS }
      )
      return parseOwnerGrant(grant)
    } catch (error) {
      const code = errorCode(error)
      if (code === METHOD_NOT_FOUND) {
        return null
      }
      if (code === OWNER_HELD_ATTACHED) {
        throw new LegacyRelayOwnerHeldError()
      }
      const transient =
        code === OWNER_RECOVERY_PENDING ||
        code === OWNER_RECOVERY_SUPERSEDED ||
        code === OWNER_HELD_DISCONNECTED ||
        code === OWNER_HELD_SELF
      if (!transient && resume) {
        // A stale claim the relay no longer recognises: ask for a fresh one.
        resume = null
        continue
      }
      if (!transient || Date.now() >= deadline || mux.isDisposed()) {
        throw error
      }
      await sleep(delayMs)
      delayMs = Math.min(delayMs * 2, 1_000)
    }
  }
}
