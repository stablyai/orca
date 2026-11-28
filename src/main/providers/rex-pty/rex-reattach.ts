import { RexControl } from './rex-control'
import type { RexDataStream } from './rex-data-stream'
import { captureRexSnapshot } from './rex-capture-snapshot'
import type { RexFreshSession } from './rex-fresh-session'
import { rexAttachedSession } from './rex-rpc-schema'
import { matchesRexServer, rexServerIdentity, type RexSessionRecord } from './rex-session-record'

export type RexDecodedSnapshot = {
  ansi: string
  cols: number
  rows: number
  continuation: Buffer
}

export type RexSnapshotDecoder = ((bytes: Buffer) => Promise<RexDecodedSnapshot>) & {
  validateArtifact?: () => Promise<void>
}

/** Attach only to the recorded live block. Never start a new program as fallback. */
export async function prepareRexReattach(
  socketPath: string,
  record: RexSessionRecord,
  decode: RexSnapshotDecoder
): Promise<{
  session: RexFreshSession
  snapshot: RexDecodedSnapshot
  tail: Buffer
  nonce: bigint
}> {
  const control = await RexControl.connect(socketPath)
  let data: RexDataStream | undefined
  let attached = false
  try {
    const server = await control.call('server.status', {}, rexServerIdentity.parse)
    if (!matchesRexServer(record.server, server)) {
      throw new Error('Rex server identity changed; automatic restore refused')
    }
    const client = await control.call(
      'session.attach',
      { session_id: record.sessionId },
      rexAttachedSession.parse
    )
    attached = true
    const opened = await captureRexSnapshot(socketPath, { control, record }, decode)
    data = opened.data
    const session: RexFreshSession = {
      id: record.id,
      sessionId: record.sessionId,
      blockId: record.blockId,
      clientId: client.client_id,
      cwd: record.cwd,
      record,
      control,
      data,
      lost: false,
      closing: false
    }
    return { session, snapshot: opened.snapshot, tail: opened.tail, nonce: opened.nonce }
  } catch (error) {
    data?.close()
    // A failed restore never kills or modifies the recorded terminal.
    if (attached) {
      await control.call('session.detach', { session_id: record.sessionId }).catch(() => undefined)
    }
    control.close()
    throw error
  }
}
