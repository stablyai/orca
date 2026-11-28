import type { RexControl } from './rex-control'
import { rexBlockExists } from './rex-block-exists'
import { proveNaturalRexExit } from './rex-exit-reclamation'
import { assertRexRootRetired, verifyRexRetirement } from './rex-retirement-evidence'
import { matchesRexServer, rexServerIdentity, type RexSessionRecord } from './rex-session-record'
import type { RexSessionStore } from './rex-session-store'

/** Read-only reconciliation of a dead controller's interrupted retirement.
 * A live or unverified block is not permission to send another close. */
export async function recoverRexRetirement(
  control: RexControl,
  store: RexSessionStore,
  record: RexSessionRecord,
  deadline: number
): Promise<boolean> {
  if (
    record.backend !== 'rex-local' ||
    record.adopted ||
    !record.rootIdentity ||
    Date.now() >= deadline
  ) {
    return false
  }
  return store.retirements.recover(record, async (pending) => {
    await store.read(record.id, record.incarnationId)
    if (pending.kind === 'natural-exit') {
      if (
        !(await proveNaturalRexExit(control, record)) ||
        !(await proveNaturalRexExit(control, record))
      ) {
        return false
      }
    } else {
      const sameServer = async () => {
        const server = await control.call('server.status', {}, rexServerIdentity.parse)
        return matchesRexServer(record.server, server)
      }
      if (
        !(await sameServer()) ||
        (await rexBlockExists(control, record.sessionId, record.blockId))
      ) {
        return false
      }
      await assertRexRootRetired(record)
      await verifyRexRetirement(pending.identities, deadline)
      if (
        !(await sameServer()) ||
        (await rexBlockExists(control, record.sessionId, record.blockId))
      ) {
        return false
      }
      await assertRexRootRetired(record)
    }
    if (Date.now() >= deadline) {
      return false
    }
    await store.remove(record.id, record.incarnationId)
    await store.retirements.remove(record)
    return true
  })
}
