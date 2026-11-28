import type { spawnCodexAppServerConnection } from '../codex-app-server-connection'
import { initializeCodexAppServerConnection } from '../codex-app-server-handshake'
import type { KeptProviderRelay } from '../../../provider-relay/app-provider-relays'
import type { CodexSharedServer } from './codex-shared-server'
import type { CodexRecoveredChat } from './codex-shared-recovery-group'
import { recoverCodexSharedServerThreads } from './codex-shared-server-reattach'
import {
  restoreCodexSharedRecovery,
  type CodexSharedServerHandedBack
} from './codex-shared-server-handback'

const INITIALIZE_TIMEOUT_MS = 15_000

/** A server the terminal daemon runs: its relay's key, and when kept, its relay and expected chats. */
export type CodexSharedServerRelayed = {
  chatKey: string
  attach?: KeptProviderRelay
  expected?: readonly CodexRecoveredChat[]
  /** What its last hand-back to the daemon kept: seeded before discovery. */
  handedBack?: CodexSharedServerHandedBack
}

/**
 * Connects and initializes the server (a kept one answers from its first app's initialize). A kept
 * one's chats' threads are placed before its held output is let through, so every frame finds the
 * chat or recovery bucket it belongs to.
 */
export async function startCodexSharedServer(
  server: CodexSharedServer,
  connect: typeof spawnCodexAppServerConnection,
  relayed: CodexSharedServerRelayed | undefined
): Promise<void> {
  const expected = relayed?.expected
  const connection = await connect(server.spec.launch, {
    onNotification: (method, params) => {
      server.turns.observe(method, params)
      server.keep.work.observe(method, params)
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
  try {
    await initializeCodexAppServerConnection(connection, INITIALIZE_TIMEOUT_MS)
  } catch (error) {
    // A server that never initialized serves nobody; the next chat gets a fresh one.
    server.draining = true
    void connection.close()
    throw error
  }
  if (expected && connection.relay?.reattached) {
    server.keep.work.seed(connection.relay.openWork())
    // Lines the spool let go may be any held chat's: each catches up from history instead.
    if (connection.relay.spoolCut?.()) {
      server.recovery.cutFromNowOn()
    }
    if (relayed?.handedBack) {
      restoreCodexSharedRecovery(server, relayed.handedBack, expected)
    }
    const unwanted = await recoverCodexSharedServerThreads({
      connection: server.keep.limited(connection),
      recovery: server.recovery,
      expected
    })
    connection.relay.releaseOutput()
    void server.keep.endThreads(unwanted, null)
  }
}
