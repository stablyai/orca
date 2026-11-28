import type { spawnCodexAppServerConnection } from '../codex-app-server-connection'
import { initializeCodexAppServerConnection } from '../codex-app-server-handshake'
import type { KeptProviderRelay } from '../../../provider-relay/app-provider-relays'
import type { CodexSharedServer } from './codex-shared-server'
import { readProcessStartTimeMs } from '../../../runtime/agent-session/ownership/agent-session-process-identity-probe'

const INITIALIZE_TIMEOUT_MS = 15_000

/** A server the terminal daemon runs: its relay's key, and when kept, its relay. */
export type CodexSharedServerRelayed = { chatKey: string; attach?: KeptProviderRelay }

/**
 * Replayed lines a chat's thread/resume rebuilds (from history and the running turn), so a replay
 * never adds to its snapshot. Anything else replayed (plan updates, goals, terminal input, request
 * control) still counts.
 */
const REBUILT_BY_RESUME: ReadonlySet<string> = new Set([
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/plan/delta',
  'item/commandExecution/outputDelta'
])

/**
 * Connects and initializes the server (a kept one answers from its first app's initialize). Each
 * chat rebuilds from Codex when it reopens, so a kept one's replay carries only what resume can't
 * give back: its requests, and frames resume doesn't rebuild.
 */
export async function startCodexSharedServer(
  server: CodexSharedServer,
  connect: typeof spawnCodexAppServerConnection,
  relayed: CodexSharedServerRelayed | undefined
): Promise<void> {
  const connection = await connect(server.spec.launch, {
    onNotification: (method, params) => {
      server.turns.observe(method, params)
      if (REBUILT_BY_RESUME.has(method) && replayed(server)) {
        return
      }
      server.router.onNotification(method, params)
    },
    onServerRequest: (request) => server.router.onServerRequest(request),
    onUnhandledFrame: (kind, payload) => {
      if (!server.router.onUnhandledFrame(kind, payload)) {
        console.warn(`[codex-shared-server] ${kind}`, server.pid ?? '')
      }
    },
    onClose: (error) => {
      // Unusable from here even before its exit is proven; new chats must not pick it.
      server.draining = true
      for (const lease of server.leases) {
        lease.serverClosing(error)
      }
    },
    onExit: (error) => server.exitedWith(error)
  }).catch((error: unknown) => {
    server.exitedWith(error instanceof Error ? error : new Error(String(error)))
    throw error
  })
  server.physicalConnection = connection
  if (relayed && connection.pid !== undefined) {
    // Its chats' runs name it; their exit proof needs its start time, or a reused pid stays "maybe".
    server.keep.serverStartTimeMs = (await readProcessStartTimeMs(connection.pid)) ?? undefined
  }
  try {
    await initializeCodexAppServerConnection(connection, INITIALIZE_TIMEOUT_MS)
  } catch (error) {
    // A server that never initialized serves nobody; the next chat gets a fresh one.
    server.draining = true
    void connection.close()
    throw error
  }
  if (connection.relay?.reattached) {
    // Its replay flows once the kept answer to initialize is in.
    connection.relay.releaseOutput()
  }
}

/** The line being read now came from a kept server's replay (spooled before this attach). */
function replayed(server: CodexSharedServer): boolean {
  const relay = server.physicalConnection?.relay
  const seq = relay?.recordSeq?.() ?? null
  return relay?.reattached === true && seq !== null && seq <= (relay.replayThrough?.() ?? 0)
}
