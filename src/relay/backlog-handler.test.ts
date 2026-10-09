import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { RelayDispatcher } from './dispatcher'
import { encodeJsonRpcFrame, MessageType } from './protocol'
import { registerBacklogHandler } from './backlog-handler'
import * as backlogService from '../main/backlog/backlog-service'

let root: string | undefined
let dispatcher: RelayDispatcher | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  dispatcher?.dispose()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('serves host-local Backlog data over real relay frames and rejects malformed mutation arguments', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'orca-backlog-relay-'))
  await mkdir(path.join(root, '.backlog/tasks'), { recursive: true })
  await writeFile(
    path.join(root, '.backlog/config.yml'),
    'project_name: Remote\nstatuses: [Waiting, Accepted]\n'
  )
  await writeFile(
    path.join(root, '.backlog/tasks/team-03 - Task.md'),
    '---\nid: TEAM-03\ntitle: Remote task\nstatus: Waiting\n---\nRemote detail\n'
  )
  const written: Buffer[] = []
  dispatcher = new RelayDispatcher((data) => {
    written.push(Buffer.from(data))
  })
  registerBacklogHandler(dispatcher)
  dispatcher.feed(
    encodeJsonRpcFrame({ jsonrpc: '2.0', id: 1, method: 'backlog.capabilities', params: {} }, 1, 0)
  )
  dispatcher.feed(
    encodeJsonRpcFrame(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'backlog.execute',
        params: { repoPath: root, operation: { kind: 'read', id: 'TEAM-03' } }
      },
      2,
      0
    )
  )
  dispatcher.feed(
    encodeJsonRpcFrame(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'backlog.execute',
        params: { repoPath: root, operation: { kind: 'edit', id: '../escape' } }
      },
      3,
      0
    )
  )
  const Response = z.object({
    id: z.number(),
    result: z.unknown().optional(),
    error: z.unknown().optional()
  })
  /** Decodes only RPC response frames so keepalive traffic cannot satisfy response assertions. */
  const responses = () =>
    written
      .filter((frame) => frame[0] === MessageType.Regular)
      .map((frame) =>
        Response.parse(JSON.parse(frame.subarray(13, 13 + frame.readUInt32BE(9)).toString('utf8')))
      )
  await vi.waitFor(() => expect(responses()).toHaveLength(3))
  expect(responses().find((response) => response.id === 1)?.result).toEqual({ version: 1 })
  expect(responses().find((response) => response.id === 2)?.result).toMatchObject({
    id: 'TEAM-03',
    title: 'Remote task',
    body: 'Remote detail'
  })
  expect(responses().find((response) => response.id === 3)?.error).toBeTruthy()
})

it.each([
  { operation: { kind: 'list' } },
  { repoPath: 42, operation: { kind: 'list' } },
  { repoPath: '', operation: { kind: 'list' } },
  { repoPath: 'p'.repeat(4097), operation: { kind: 'list' } },
  { repoPath: '/project', operation: { kind: 'delete', id: 'TASK-1' } },
  { repoPath: '/project', operation: { kind: 'edit', id: 'TASK-1' } }
])('rejects invalid relay payloads before host execution: %j', async (params) => {
  const execute = vi.spyOn(backlogService, 'executeBacklogOperation')
  const written: Buffer[] = []
  dispatcher = new RelayDispatcher((data) => {
    written.push(Buffer.from(data))
  })
  registerBacklogHandler(dispatcher)
  dispatcher.feed(
    encodeJsonRpcFrame({ jsonrpc: '2.0', id: 1, method: 'backlog.execute', params }, 1, 0)
  )
  await vi.waitFor(() => expect(written).toHaveLength(1))
  const frame = written[0]!
  expect(JSON.parse(frame.subarray(13, 13 + frame.readUInt32BE(9)).toString('utf8'))).toMatchObject(
    {
      id: 1,
      error: { code: -32000 }
    }
  )
  expect(execute).not.toHaveBeenCalled()
})
