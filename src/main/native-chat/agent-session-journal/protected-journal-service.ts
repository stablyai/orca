import { Socket } from 'node:net'
import { join } from 'node:path'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { z } from 'zod'
import { JournalSqlDatabase } from './database/journal-sql-database'
import { protectedFrames, sendProtectedFrame } from './protected-journal-framing'
import { ProtectedJournalBackend } from './protected-journal-backend'
import type { ProtectedJournalCall, ProtectedJournalPolicy } from './protected-journal-wire'

export async function serveProtectedConnection(
  socket: Socket,
  backend: ProtectedJournalBackend,
  epoch: string,
  publish?: () => void
) {
  for await (const input of protectedFrames(socket)) {
    if (
      !input ||
      typeof input !== 'object' ||
      !('version' in input) ||
      input.version !== 1 ||
      !('epoch' in input) ||
      input.epoch !== epoch ||
      !('call' in input) ||
      !input.call ||
      typeof input.call !== 'object' ||
      !('op' in input.call) ||
      !['open', 'write', 'history', 'point', 'epoch', 'upload'].includes(String(input.call.op))
    ) {
      throw new Error('incompatible protected journal frame')
    }
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this connected descriptor is passed only by the kernel-peer gate; the backend independently binds every operation to its enrolled session.
      const value = await backend.execute(input.call as ProtectedJournalCall)
      await sendProtectedFrame(socket, { ok: true, value })
      if (input.call.op === 'write') {
        publish?.()
      }
    } catch {
      await sendProtectedFrame(socket, { ok: false })
    }
  }
}

export async function runProtectedJournalService(publish?: () => void) {
  const config = '/private/etc/orca/committed-journal.json'
  const state = '/private/var/orca-committed-journal/profile'
  const uid = process.getuid?.()
  if (uid === undefined || uid === 0) {
    throw new Error('protected writer requires a dedicated unprivileged account')
  }
  const info = await lstat(config)
  if (
    info.uid !== 0 ||
    !info.isFile() ||
    info.mode & 0o022 ||
    info.size > 4096 ||
    (await realpath(config)) !== config
  ) {
    throw new Error('invalid protected writer policy')
  }
  const policy = z
    .strictObject({
      version: z.literal(1),
      botId: z.uuid(),
      workspaceId: z.string().startsWith('folder:'),
      writerEpoch: z.uuid(),
      socketPath: z.literal('/private/var/orca-committed-journal/service.sock'),
      producerUid: z.number().int().positive()
    })
    .parse(JSON.parse(await readFile(config, 'utf8')))
  const file = join(state, 'agent-session-domain.db')
  const entry = await lstat(file),
    folder = await lstat(state)
  if (
    uid !== policy.producerUid ||
    entry.uid !== uid ||
    !entry.isFile() ||
    entry.nlink !== 1 ||
    entry.mode & 0o077 ||
    !folder.isDirectory() ||
    folder.uid !== uid ||
    folder.mode & 0o077 ||
    (await realpath(file)) !== file
  ) {
    throw new Error('protected journal ownership mismatch')
  }
  const root = __dirname
  const db = await JournalSqlDatabase.open(state, {
    writerPath: join(root, 'journal-sql-worker-entry.js'),
    readerPath: join(root, 'journal-sql-reader-entry.js'),
    protectedEnrollment: policy,
    onMaintenanceError: () => {}
  })
  const fd = Number(process.argv[2])
  if (!Number.isSafeInteger(fd) || fd < 3) {
    throw new Error('missing authenticated journal descriptor')
  }
  const socket = new Socket({ fd, readable: true, writable: true })
  try {
    publish?.()
    const grant: ProtectedJournalPolicy = policy
    await serveProtectedConnection(
      socket,
      new ProtectedJournalBackend(db, grant),
      policy.writerEpoch,
      publish
    )
  } finally {
    socket.destroy()
    await db.close()
  }
}
