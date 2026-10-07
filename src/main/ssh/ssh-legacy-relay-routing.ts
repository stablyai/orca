import type { SshConnection } from './ssh-connection'
import { execCommand, waitForSentinel } from './ssh-relay-deploy-helpers'
import { SshLegacyRelayRoute, type LegacyRelayRouteSink } from './ssh-legacy-relay-route'
import { SshLegacyRelayRouter } from './ssh-legacy-relay-router'
import { previousRelayCensus } from './ssh-previous-relay-terminals'
import { readRelayDaemonRuntimes } from './ssh-relay-endpoint-runtime'

const routersByTarget = new Map<string, SshLegacyRelayRouter>()

/**
 * The PTYs this target's earlier-build relays still run. Null when that cannot be known: an
 * incomplete census, a live Windows pipe (never bridged), no router, or an older relay that did not
 * answer.
 */
export async function listPreviousRelayPtyIds(targetId: string): Promise<string[] | null> {
  const census = await previousRelayCensus(targetId)
  if (!census.complete) {
    return null
  }
  if (census.endpoints.length === 0) {
    return []
  }
  if (!census.bridgeable) {
    return null
  }
  return (await routersByTarget.get(targetId)?.listHeld()) ?? null
}

/** The router a target's provider consults for PTYs only an earlier build's relay still runs. */
export function createSshLegacyRelayRouter(args: {
  targetId: string
  connection: () => SshConnection | null
  clientInstanceId: string
  sink: LegacyRelayRouteSink
}): SshLegacyRelayRouter {
  const { targetId } = args
  const router = new SshLegacyRelayRouter({
    targetId,
    endpoints: async () => {
      const census = await previousRelayCensus(targetId)
      return census.bridgeable ? census.endpoints : []
    },
    unreachableMayHold: async () => {
      const census = await previousRelayCensus(targetId)
      return !census.complete || (!census.bridgeable && census.endpoints.length > 0)
    },
    openRoute: async (sockPath) => {
      const census = await previousRelayCensus(targetId)
      const conn = args.connection()
      if (!conn) {
        return null
      }
      // An older relay may run on an older Node pin or host Node; its bridge must use that runtime.
      const nodePath = (await readRelayDaemonRuntimes(conn)).get(sockPath) ?? census.nodePath
      if (!nodePath) {
        return null
      }
      return await SshLegacyRelayRoute.open({
        targetId,
        sockPath,
        nodePath,
        clientInstanceId: args.clientInstanceId,
        sink: args.sink,
        openTransport: async (command) => await waitForSentinel(await conn.exec(command)),
        readText: (command) => execCommand(conn, command, { wrapCommand: true })
      })
    }
  })
  routersByTarget.set(targetId, router)
  router.onDispose(() => {
    if (routersByTarget.get(targetId) === router) {
      routersByTarget.delete(targetId)
    }
  })
  return router
}
