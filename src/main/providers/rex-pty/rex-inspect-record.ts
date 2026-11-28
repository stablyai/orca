import { matchesRexRootIdentity } from './rex-root-identity'
import { assertRexRootRetired } from './rex-retirement-evidence'
import type { PtyProcessInfo } from '../pty/process-info'
import type { RexSessionRecord } from './rex-session-record'
import { matchesRexServer, rexServerIdentity, verifyRexIdentity } from './rex-session-record'
import { rexListedSessions, rexListedBlocks, rexTerminalProcess } from './rex-rpc-schema'
import type { RexControl } from './rex-control'

/** The absence of a local attachment is never evidence of process death. */
export async function inspectRexRecord(
  control: RexControl,
  record: RexSessionRecord
): Promise<PtyProcessInfo | null> {
  if (record.backend !== 'rex-local' || record.adopted) {
    throw new Error('External Rex record is outside local inventory authority')
  }
  const server = await control.call('server.status', {}, rexServerIdentity.parse)
  if (!matchesRexServer(record.server, server)) {
    throw new Error('Rex inventory server identity changed')
  }
  const list = await control.call('session.list', {}, rexListedSessions.parse)
  if (!list.sessions?.some((s) => s.session_id === record.sessionId)) {
    await assertRexRootRetired(record)
    return null
  }
  await control.call('session.attach', { session_id: record.sessionId })
  try {
    const blocks = await control.call(
      'session.list_blocks',
      { session_id: record.sessionId },
      rexListedBlocks.parse
    )
    if (!blocks.blocks?.some((b) => b.block_id === record.blockId)) {
      await assertRexRootRetired(record)
      return null
    }
    const process = await control.call(
      'com.superlogical.terminal.process',
      { session_id: record.sessionId, block_id: record.blockId, args: {} },
      rexTerminalProcess.parse
    )
    if (process.last_exit && !process.child) {
      await assertRexRootRetired(record)
      return null
    }
    verifyRexIdentity(record, server, process.child?.pid)
    if (process.last_exit) {
      throw new Error('Rex process state inconsistent')
    }
    if (!(await matchesRexRootIdentity(record))) {
      throw new Error('Rex inventory root identity changed or unavailable')
    }
    return {
      id: record.id,
      incarnationId: record.incarnationId,
      rootProcessId: record.rootPid,
      cwd: process.foreground?.cwd ?? process.child?.cwd ?? record.cwd,
      title: 'Rex',
      ...(process.foreground?.name ? { foregroundProcess: process.foreground.name } : {}),
      ...(record.worktreeId ? { worktreeId: record.worktreeId } : {}),
      ...(record.paneKey ? { paneKey: record.paneKey, paneBound: true } : {})
    }
  } finally {
    await control.call('session.detach', { session_id: record.sessionId })
  }
}
