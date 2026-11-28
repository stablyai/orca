import { rexBlockExists } from './rex-block-exists'
import { recoverRexRetirement } from './rex-retirement-recovery'
import { z } from 'zod'
import { RexControl } from './rex-control'
import { matchesRexServer, rexServerIdentity, type RexSessionRecord } from './rex-session-record'
import { rexTerminalProcess } from './rex-rpc-schema'
import { captureRexRetirement, verifyRexRetirement } from './rex-retirement-evidence'
import type { RexSessionStore } from './rex-session-store'
import type { RexRetirementJournal } from './rex-retirement-journal'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'

const closedBlock = lazyZodSchema(() =>
  z.object({ block_id: z.string(), revision: z.number().int().nonnegative() })
)
async function closeConfirmed(
  connection: RexControl,
  sessionId: string,
  blockId: string,
  message: string
): Promise<void> {
  const reply = await connection.call(
    'block.close',
    { session_id: sessionId, block_id: blockId, undoable: false },
    closedBlock.parse
  )
  if (reply.block_id !== blockId || (await rexBlockExists(connection, sessionId, blockId))) {
    throw new Error(message)
  }
}

// Failed fresh launches may close only on the original authenticated connection.
export async function closeUnreleasedRexBlock(
  connection: RexControl,
  sessionId: string,
  blockId: string
): Promise<void> {
  if (connection.isClosed) {
    throw new Error('Rex creation cleanup connection lost')
  }
  await connection.call('session.attach', { session_id: sessionId })
  await closeConfirmed(connection, sessionId, blockId, 'Rex cleanup not confirmed')
}

async function closeRexBlock(
  socketPath: string,
  record: RexSessionRecord,
  journal: RexRetirementJournal,
  deadlineMs = Date.now() + 8000
): Promise<void> {
  if (record.adopted || record.backend !== 'rex-local') {
    throw new Error('Cannot terminate adopted or external Rex block')
  }
  const { sessionId, blockId } = record
  const deadline = Math.min(deadlineMs, Date.now() + 8000)
  const connection = await RexControl.connect(socketPath)
  const timer = setTimeout(() => connection.close(), Math.max(0, deadline - Date.now()))
  try {
    const server = await connection.call('server.status', {}, rexServerIdentity.parse)
    if (!matchesRexServer(record.server, server)) {
      throw new Error('Rex server identity changed; close refused')
    }
    const prior = await journal.read(record)
    if (prior) {
      throw new Error('Rex termination outcome unknown; reconcile before retry')
    }
    if (!(await rexBlockExists(connection, sessionId, blockId))) {
      throw new Error('Rex termination outcome unknown: block vanished before census')
    }
    const read = () =>
      connection.call(
        'com.superlogical.terminal.process',
        { session_id: sessionId, block_id: blockId, args: {} },
        rexTerminalProcess.parse
      )
    const current = await read()
    const exited = !!current.last_exit && !current.child
    if (!exited && (current.child?.pid !== record.rootPid || current.last_exit)) {
      throw new Error('Rex process identity changed; close refused')
    }
    const identities = await captureRexRetirement(record, deadline, exited)
    const checked = await read()
    if (
      exited
        ? !checked.last_exit || !!checked.child
        : checked.child?.pid !== record.rootPid || !!checked.last_exit
    ) {
      throw new Error('Rex process changed during retirement census')
    }
    if (Date.now() >= deadline) {
      throw new Error('Rex termination deadline elapsed')
    }
    await journal.reserve(record, identities)
    // Other clients can add blocks to this session; never destroy the whole session.
    await closeConfirmed(connection, sessionId, blockId, 'Rex block close not confirmed')
    await verifyRexRetirement(identities, deadline)
  } finally {
    clearTimeout(timer)
    connection.close()
  }
}

export async function retireRexSession(
  endpoint: string,
  record: RexSessionRecord,
  store: RexSessionStore,
  deadlineMs?: number
): Promise<void> {
  if (await store.retirements.read(record)) {
    const control = await RexControl.connect(endpoint)
    const deadline = Math.min(deadlineMs ?? Infinity, Date.now() + 8000)
    const timer = setTimeout(() => control.close(), Math.max(0, deadline - Date.now()))
    try {
      if (await recoverRexRetirement(control, store, record, deadline)) {
        return
      }
      throw new Error('Rex termination outcome unknown; no second close will be sent')
    } finally {
      clearTimeout(timer)
      control.close()
    }
  }
  await closeRexBlock(endpoint, record, store.retirements, deadlineMs)
  await store.remove(record.id, record.incarnationId)
  await store.retirements.remove(record)
}
