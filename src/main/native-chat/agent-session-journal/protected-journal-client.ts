import type { ProtectedUpload } from './protected-journal-uploads'
import { constants } from 'node:fs'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { connect, type Socket } from 'node:net'
import { readFile, lstat, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { JournalSqlSendingChats } from './journal-sql-activity'
import type { JournalSqlOwner } from './journal-sql-owner'
import type { JournalWriterCommit } from './journal-writer-changes'
import type {
  ProtectedJournalCall,
  ProtectedJournalPolicy,
  SessionDatabase
} from './protected-journal-wire'
import { protectedFrames, sendProtectedFrame } from './protected-journal-framing'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalOpenRecovery } from './journal-writer-command'

const policySchema = lazyZodSchema(() =>
  z.strictObject({
    version: z.literal(1),
    botId: z.uuid(),
    workspaceId: z.string().startsWith('folder:'),
    writerEpoch: z.uuid(),
    producerUid: z.number().int().positive(),
    socketPath: z.literal('/private/var/orca-committed-journal/service.sock')
  })
)
const policyFile = '/private/etc/orca/committed-journal.json'

async function policy(): Promise<ProtectedJournalPolicy | null> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return null
  }
  let info
  try {
    info = await lstat(policyFile)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
  if (!info.isFile() || info.uid !== 0 || info.mode & 0o022 || info.size > 4096) {
    throw new Error('unsafe protected journal routing policy')
  }
  for (let p = dirname(policyFile); ; p = dirname(p)) {
    const parent = await lstat(p)
    if (!parent.isDirectory() || parent.uid !== 0 || parent.mode & 0o022) {
      throw new Error('unsafe protected journal routing directory')
    }
    if (p === '/') {
      break
    }
  }
  return policySchema.parse(JSON.parse(await readFile(policyFile, 'utf8')))
}

export class ProtectedJournalClient implements SessionDatabase {
  readonly sending = new JournalSqlSendingChats(() => {})
  private readonly frames
  private tail: Promise<unknown> = Promise.resolve()
  private lane: Promise<unknown> = Promise.resolve()
  private queued = 0
  constructor(
    private readonly socket: Socket,
    private readonly grant: ProtectedJournalPolicy
  ) {
    this.frames = protectedFrames(socket)
    socket.on('timeout', () => socket.destroy(new Error('protected journal timed out')))
  }
  private request<T>(call: ProtectedJournalCall): Promise<T> {
    if (this.queued >= 64) {
      return Promise.reject(new Error('protected journal queue is full'))
    }
    this.queued++
    const job = this.tail.then(async () => {
      if (this.socket.destroyed) {
        throw new Error('protected journal disconnected; reopen the chat')
      }
      this.socket.setTimeout(30000)
      await sendProtectedFrame(this.socket, { version: 1, epoch: this.grant.writerEpoch, call })
      const next = await this.frames.next()
      this.socket.setTimeout(0)
      if (
        next.done ||
        !next.value ||
        typeof next.value !== 'object' ||
        !('ok' in next.value) ||
        next.value.ok !== true ||
        !('value' in next.value)
      ) {
        throw new Error('protected journal request refused or acknowledgement lost')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: one in-flight call; the protected product writer supplies the corresponding native journal result.
      return next.value.value as T
    })
    this.tail = job
      .catch(() => {})
      .finally(() => {
        this.queued--
      })
    return job
  }
  readonly readers: SessionDatabase['readers'] = {
    point: (request) => this.request({ op: 'point', request }),
    domainHistoryFrame: (request, work, signal) => {
      signal?.throwIfAborted()
      return this.request({ op: 'history', request, work })
    }
  }
  async openSession(
    identity: AgentSessionJournalIdentity,
    _savedAt?: number,
    recover?: JournalOpenRecovery
  ) {
    if (identity.workspaceId !== this.grant.workspaceId) {
      throw new Error('wrong protected journal workspace')
    }
    return this.request<Awaited<ReturnType<JournalSqlDatabase['openSession']>>>({
      op: 'open',
      identity,
      recover
    })
  }
  found(call: Extract<ProtectedJournalCall, { op: 'found' }>) {
    return this.request(call)
  }
  placement(call: Extract<ProtectedJournalCall, { op: 'placement' }>) {
    return this.request(call)
  }
  upload(upload: ProtectedUpload) {
    return this.request({ op: 'upload', upload })
  }
  sessionEpoch(sessionId: string) {
    return this.request<string | null>({ op: 'epoch', sessionId })
  }
  rememberSessionEpoch() {}
  requestSweep() {}
  serialize<T>(
    _sessionId: string,
    run: (writer: Pick<JournalSqlOwner, 'write' | 'maintain' | 'effects'>) => T | Promise<T>
  ): Promise<T> {
    const refuse = () => Promise.reject(new Error('operation unavailable on a protected journal'))
    const job = this.lane.then(() =>
      run({
        write: (command) => {
          const effects = command.effects?.map((effect) => {
            if (
              effect.kind !== 'store' ||
              effect.mutation.input.kind !== 'command' ||
              effect.mutation.input.command.kind !== 'found'
            ) {
              return effect
            }
            const found = effect.mutation.input.command
            const { launchEnv: _env, ...request } = found.request
            return {
              ...effect,
              mutation: {
                ...effect.mutation,
                input: {
                  kind: 'command' as const,
                  command: { ...found, request: { ...request, spawnToken: '' } }
                }
              }
            }
          })
          return this.request<JournalWriterCommit>({
            op: 'write',
            command: { ...command, effects }
          })
        },
        effects: refuse,
        maintain: refuse
      })
    )
    this.lane = job.catch(() => {})
    return job
  }
}

let client: { epoch: string; socket: Socket; client: ProtectedJournalClient } | undefined
export async function selectSessionDatabase(
  identity: AgentSessionJournalIdentity,
  ordinary: JournalSqlDatabase
): Promise<SessionDatabase> {
  const selected = await policy()
  if (!selected || identity.workspaceId !== selected.workspaceId) {
    return ordinary
  }
  return protectedClient(selected)
}

async function protectedClient(selected: ProtectedJournalPolicy) {
  if (!client || client.epoch !== selected.writerEpoch || client.socket.destroyed) {
    client?.socket.destroy()
    const parent = await lstat(dirname(selected.socketPath))
    const endpoint = await lstat(selected.socketPath)
    if (
      !parent.isDirectory() ||
      parent.uid !== 0 ||
      parent.mode & 0o022 ||
      !endpoint.isSocket() ||
      (endpoint.uid !== 0 && endpoint.uid !== selected.producerUid) ||
      selected.producerUid === process.getuid?.()
    ) {
      throw new Error('unprotected journal endpoint')
    }
    const socket = connect(selected.socketPath)
    socket.on('error', () => socket.destroy())
    client = {
      epoch: selected.writerEpoch,
      socket,
      client: new ProtectedJournalClient(socket, selected)
    }
  }
  return client.client
}

export async function retainSessionUpload(
  workspaceId: string,
  sessionId: string,
  uploadId: string,
  name: string,
  path: string,
  expectedHash: string
) {
  const selected = await policy()
  if (!selected || selected.workspaceId !== workspaceId) {
    return
  }
  const fd = await open(path, constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_RDONLY)
  try {
    const info = await fd.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024) {
      throw new Error('invalid committed upload')
    }
    const bytes = await fd.readFile()
    if (bytes.length !== info.size) {
      throw new Error('upload changed during admission')
    }
    await (
      await protectedClient(selected)
    ).upload({ workspaceId, sessionId, uploadId, name, bytes, sourcePath: path, expectedHash })
  } finally {
    await fd.close()
  }
}

export async function reserveProtectedJournalSession(
  workspaceId: string,
  sessionId: string,
  provider: string,
  operationId: string
) {
  const selected = await policy()
  if (!selected || selected.workspaceId !== workspaceId) {
    return false
  }
  await (
    await protectedClient(selected)
  ).found({ op: 'found', workspaceId, sessionId, provider, operationId })
  return true
}
export async function mirrorProtectedPlacement(
  request: Extract<ProtectedJournalCall, { op: 'placement' }>['request']
) {
  const selected = await policy()
  if (!selected || selected.workspaceId !== request.location.workspaceId) {
    return
  }
  await (await protectedClient(selected)).placement({ op: 'placement', request })
}
