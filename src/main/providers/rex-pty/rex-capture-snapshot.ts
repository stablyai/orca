import { matchesRexRootIdentity } from './rex-root-identity'
import { REX_MAX_SNAPSHOT_BYTES, rexSnapshotJobs } from './rex-memory-budget'
import { RexDataStream } from './rex-data-stream'
import type { RexFreshSession } from './rex-fresh-session'
import type { RexSnapshotDecoder, RexDecodedSnapshot } from './rex-reattach'
import { rexDataTicket, rexTerminalProcess } from './rex-rpc-schema'
import type { PtySpawnResult } from '../pty/spawn-result'
import type { RexSessionRecord } from './rex-session-record'
import { rexServerIdentity, verifyRexIdentity } from './rex-session-record'

/** The new stream's snapshot and tail share an atomic Rex transport boundary. */
export async function captureRexSnapshot(
  socketPath: string,
  session: Pick<RexFreshSession, 'control' | 'record'>,
  decode: RexSnapshotDecoder
): Promise<{ data: RexDataStream; snapshot: RexDecodedSnapshot; tail: Buffer; nonce: bigint }> {
  const { control, record } = session
  const verifyRootStart = async () => {
    if (record.backend !== 'rex-local' || !record.rootIdentity) {
      return
    }
    if (!(await matchesRexRootIdentity(record))) {
      throw new Error('Rex root process start identity changed')
    }
  }
  await verifyRootStart()
  const target = { session_id: record.sessionId, block_id: record.blockId }
  const server = await control.call('server.status', {}, rexServerIdentity.parse)
  const process = await control.call(
    'com.superlogical.terminal.process',
    { ...target, args: {} },
    rexTerminalProcess.parse
  )
  verifyRexIdentity(record, server, process.child?.pid)
  if (process.last_exit) {
    throw new Error('Rex process exited before capture')
  }
  const release = await rexSnapshotJobs.acquire()
  try {
    const ticket = await control.call(
      'data.connect',
      { ...target, data_ref_id: 'terminal', subprotocol: 'rex.data.terminal.v1' },
      rexDataTicket.parse
    )
    const opened = await RexDataStream.open(socketPath, ticket.ticket, true)
    try {
      if (!opened.snapshot) {
        throw new Error('Missing Rex snapshot')
      }
      const snapshot = await decode(opened.snapshot)
      if (
        !Number.isInteger(snapshot.cols) ||
        snapshot.cols < 1 ||
        snapshot.cols > 1000 ||
        !Number.isInteger(snapshot.rows) ||
        snapshot.rows < 1 ||
        snapshot.rows > 1000 ||
        Buffer.byteLength(snapshot.ansi) > REX_MAX_SNAPSHOT_BYTES ||
        snapshot.continuation.length > 1024 * 1024
      ) {
        throw new Error('Rex decoded snapshot exceeds limits')
      }
      const current = await control.call(
        'com.superlogical.terminal.process',
        { ...target, args: {} },
        rexTerminalProcess.parse
      )
      verifyRexIdentity(record, server, current.child?.pid)
      if (current.last_exit) {
        throw new Error('Rex process exited during capture')
      }
      await verifyRootStart()
      return { data: opened.stream, snapshot, tail: opened.tail, nonce: opened.nonce }
    } catch (error) {
      opened.stream.close()
      throw error
    }
  } finally {
    release()
  }
}

export function rexSnapshotSpawnResult(
  record: RexSessionRecord,
  snapshot: RexDecodedSnapshot
): PtySpawnResult {
  return {
    id: record.id,
    incarnationId: record.incarnationId,
    pid: record.rootPid,
    isReattach: true,
    snapshot: snapshot.ansi,
    snapshotCols: snapshot.cols,
    snapshotRows: snapshot.rows,
    providerSequence: { value: 0, generation: 'reset' }
  }
}
