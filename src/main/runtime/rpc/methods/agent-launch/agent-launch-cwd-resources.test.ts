import type * as RuntimeEnvironmentStore from '../../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('../../../../../cli/runtime-client', async () => {
  const harnessPath = '../../../../../cli/index-test-harness.js'
  const {
    createRuntimeClientModuleMock
  }: { createRuntimeClientModuleMock: RuntimeClientModuleMockFactory } = await import(harnessPath)
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('../../../../../cli/runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock(
  '../../../../../shared/remote-runtime/host-store/runtime-environment-store',
  async (importOriginal) => ({
    ...(await importOriginal<typeof RuntimeEnvironmentStore>()),
    listEnvironments: listEnvironmentsMock
  })
)

import { createConnection } from 'node:net'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  RuntimeClientModuleMockFactory,
  AgentLaunchCwdCliEntry,
  AgentLaunchCwdEnvironmentBindings,
  AgentLaunchCwdWorktreeFixtures,
  AgentLaunchCwdAgentFixtures
} from './agent-launch-cwd-cli.test-fixture'
import './agent-launch-cwd-cli.test-fixture'
const cliPath = '../../../../../cli/index'
const { main }: AgentLaunchCwdCliEntry = await import(cliPath)
const harnessPath = '../../../../../cli/index-test-harness'
const {
  useWorktreeAwarenessEnvironment: configureWorktreeAwarenessEnvironment
}: AgentLaunchCwdEnvironmentBindings = await import(harnessPath)
const fixturesPath = '../../../../../cli/test-fixtures'
const { buildWorktree, worktreeListFixture }: AgentLaunchCwdWorktreeFixtures = await import(
  fixturesPath
)
const agentFixturesPath = '../../../../../cli/agent-launch-test-fixtures'
const { agentLaunchHostFixture }: AgentLaunchCwdAgentFixtures = await import(agentFixturesPath)

import { RuntimeRpcFailureError } from '../../../../../cli/runtime/types'
import { RpcDispatcher } from '../../dispatcher'
import { UnixSocketTransport } from '../../unix-socket-transport'
import { AGENT_LAUNCH_METHODS } from './agent-launch'
import { WORKTREE_METHODS } from '../workspaces/worktree'
import '../../../orca-runtime-tests/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../../orca-runtime'
import '../../../orca-runtime-tests/orca-runtime-test-lifecycle.spec'
import {
  store as runtimeStore,
  TEST_WORKTREE_ID
} from '../../../orca-runtime-tests/orca-runtime-test-fixtures.spec'
import { openTestAgentSessionRecordStore } from '../../../agent-session/records/agent-session-record-store-test-harness'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabase
} from '../../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { setAgentLaunchRecordStore } from './agent-launch.test-fixture'
import { RuntimeWorktreeLineageController } from '../../../workspaces/lineage/runtime-worktree-lineage-controller'
import { formatAmbiguousCwdParentMessage } from '../../../workspaces/lineage/runtime-worktree-lineage-resolution'
import { managedCwdLaunchFixture } from './managed-cwd-launch.test-fixture'

configureWorktreeAwarenessEnvironment({
  callMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
})

// Actual local framing, including named pipes on Windows, precedes dispatch and schema validation.
async function socketCall(endpoint: string, frame: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection(endpoint)
    let response = ''
    socket.setEncoding('utf8')
    socket.setTimeout(10_000, () => socket.destroy(new Error('fixture RPC timed out')))
    socket.on('error', reject)
    socket.on('connect', () => socket.write(frame))
    socket.on('data', (chunk) => {
      response += chunk.toString()
      if (response.includes('\n')) {
        socket.end()
        resolve(response.trim())
      }
    })
  })
}

describe('CLI cwd resource frames, managed receipts and raw-path controls', () => {
  let directory: string
  let transport: UnixSocketTransport
  let prior: typeof process.exitCode
  const childStateDirectories = new Set<string>()
  beforeEach(async () => {
    vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
    vi.stubEnv('ORCA_STRUCTURED_SESSION', undefined)
    directory = await mkdtemp(join(tmpdir(), 'orca-cwd-receipt-'))
    prior = process.exitCode
    const saved = runtimeStore.getAllWorktreeMeta()
    const metadata = {
      ...saved,
      [TEST_WORKTREE_ID]: { ...saved[TEST_WORKTREE_ID]!, instanceId: 'parent-instance' }
    }
    vi.spyOn(runtimeStore, 'getAllWorktreeMeta').mockReturnValue(metadata)
    vi.spyOn(runtimeStore, 'getWorktreeMeta').mockImplementation((id) => metadata[id])
  })
  afterEach(async () => {
    const failures: unknown[] = []
    try {
      await transport?.stop()
    } catch (error) {
      failures.push(error)
    }
    setAgentLaunchRecordStore(null)
    for (const stateDirectory of [...childStateDirectories, directory]) {
      try {
        await closeTestJournalHostDatabase(stateDirectory)
      } catch (error) {
        failures.push(error)
      }
    }
    childStateDirectories.clear()
    try {
      await rm(directory, { recursive: true, force: true })
    } catch (error) {
      failures.push(error)
    }
    process.exitCode = prior
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    if (failures.length > 0) {
      throw new AggregateError(failures, 'cwd resource fixture cleanup failed')
    }
  })

  it.each(['uuid', 'root+instances'] as const)(
    'measures real managed Codex T/X framing, receipts and restart at N/10N (%s)',
    async (shape) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const samples: {
        count: number
        valid: boolean
        operations: number
        elapsedMs: number
        jsonBytes: number
        frameBytes: number
        replyBytes: number
        rowBytes: number
        reopenedReplyBytes: number
        textBytes: number
        prettyJsonBytes: number
        normalizedReplyBytes: number
        normalizedRowBytes: number
      }[] = []
      for (const count of [1000, 10000]) {
        const stateDirectory = join(directory, `${shape}-${count}`)
        await mkdir(stateDirectory)
        childStateDirectories.add(stateDirectory)
        let records = await openTestAgentSessionRecordStore(stateDirectory)
        const parentBase = buildWorktree('/tmp/scale-parent', 'main', 'abc', 'parent-repo')
        const parent = {
          ...parentBase,
          id:
            shape === 'uuid'
              ? `${parentBase.id}::workspace:00000000-1111-4111-8111-111111111111`
              : parentBase.id
        }
        const host = managedCwdLaunchFixture(records, parent, stateDirectory)
        const writes = vi.spyOn(records, 'recordOperationOutcome')
        const lineage = vi.spyOn(RuntimeWorktreeLineageController.prototype, 'resolveCreate')
        const rows = Array.from({ length: count }, (_, index) => {
          const id =
            index === 0
              ? parent.id
              : `${parentBase.id}::workspace:${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
          return {
            ...parentBase,
            get id() {
              operations++
              return id
            },
            get path() {
              operations++
              return parent.path
            },
            get hostId() {
              operations++
              return 'local' as const
            }
          }
        })
        let operations = 0
        let dispatcher = new RpcDispatcher({
          runtime: host.runtime,
          methods: [...AGENT_LAUNCH_METHODS, ...WORKTREE_METHODS]
        })
        const endpoint =
          process.platform === 'win32'
            ? `\\\\.\\pipe\\orca-managed-scale-${randomUUID()}`
            : join(stateDirectory, 's.sock')
        transport = new UnixSocketTransport({
          endpoint,
          kind: process.platform === 'win32' ? 'named-pipe' : 'unix'
        })
        const frames: string[] = []
        const replies: string[] = []
        let execution = () => [
          lineage.mock.calls.length,
          host.showTerminal.mock.calls.length,
          host.catalog.mock.calls.length,
          host.showRepo.mock.calls.length,
          host.create.mock.calls.length,
          host.start.mock.calls.length,
          host.publish.mock.calls.length,
          host.save.mock.calls.length
        ]
        const settledExecution: number[][] = []
        transport.onMessage((raw, reply) => {
          const request = JSON.parse(raw)
          const before = execution()
          void dispatcher.dispatch(request).then((response) => {
            const serialized = JSON.stringify(response)
            if (request.method === 'agent.launchReplay') {
              replies.push(serialized)
              settledExecution.push(execution().map((n, i) => n - before[i]!))
            }
            reply(serialized)
          })
        })
        await transport.start()
        callMock.mockImplementation(async (method, params) => {
          if (method === 'worktree.list') {
            return worktreeListFixture(rows)
          }
          if (method === 'status.get') {
            return agentLaunchHostFixture()
          }
          const frame = `${JSON.stringify({ id: 'scale', authToken: 'fixture', method, params })}\n`
          frames.push(frame)
          const response = JSON.parse(await socketCall(endpoint, frame))
          if (!response.ok) {
            throw new RuntimeRpcFailureError(response)
          }
          return response
        })
        const argv = [
          'worktree',
          'create',
          '--repo',
          'id:repo-1',
          '--name',
          'child',
          '--agent',
          'codex'
        ]
        const operationIds: string[] = []
        const originals = new Map<string, { reply: Record<string, unknown>; row: string }>()
        const normalize = (value: unknown, id: string) =>
          JSON.stringify(value, (key, entry) =>
            key === 'runtimeId'
              ? 'runtime'
              : key === 'operationId' || entry === id
                ? 'operation'
                : ['recordedAt', 'expiresAt', 'operationTimestamp'].includes(key)
                  ? 0
                  : key === 'worktreeId' && entry === host.childId
                    ? 'created-workspace'
                    : entry
          )

        for (const valid of [true, false]) {
          process.env.ORCA_TERMINAL_HANDLE = valid ? host.caller : 'term_X'
          process.exitCode = prior
          operations = 0
          log.mockClear()
          error.mockClear()
          const effectBefore = [
            host.start.mock.calls.length,
            host.save.mock.calls.length,
            host.publish.mock.calls.length
          ]
          const lineageBefore = lineage.mock.calls.length
          const writeBefore = writes.mock.calls.length
          const started = performance.now()
          await main([...argv, '--json'], parent.path)
          const elapsedMs = performance.now() - started
          const launchFrame = frames.findLast(
            (frame) => JSON.parse(frame).method === 'agent.launchReplay'
          )!
          const envelope = JSON.parse(launchFrame)
          const operationId = String(envelope.params.operationId)
          operationIds.push(operationId)
          const { cwdParentAmbiguous, ...oldCreate } = envelope.params.target.create
          const oldProjection = {
            ...envelope,
            params: { ...envelope.params, target: { ...envelope.params.target, create: oldCreate } }
          }
          expect(cwdParentAmbiguous).toBe(true)
          expect(envelope.params.target.create.cwdParentWorktree).toBe(`id:${parent.id}`)
          const frameBytes = Buffer.byteLength(launchFrame)
          const jsonBytes = Buffer.byteLength(launchFrame.slice(0, -1))
          expect(jsonBytes).toBe(Buffer.byteLength(JSON.stringify(oldProjection)) + 26)
          expect(frameBytes).toBe(jsonBytes + 1)
          expect(frameBytes).toBeLessThan(1024 * 1024)
          expect(operations).toBeLessThanOrEqual(50 * count)
          expect(lineage.mock.calls.length - lineageBefore).toBe(1)
          expect(writes.mock.calls.length - writeBefore).toBeGreaterThanOrEqual(1)
          expect(writes.mock.calls.length - writeBefore).toBeLessThanOrEqual(3)
          const measuredOperations = operations
          const output = JSON.parse(log.mock.calls.flat().join('\n'))
          expect(output.ok, error.mock.calls.flat().join('\n')).toBe(valid)
          expect(process.exitCode).toBe(valid ? prior : 1)
          expect(host.start.mock.calls.length - effectBefore[0]!).toBe(valid ? 1 : 0)
          if (!valid) {
            expect(
              host.save.mock.calls.length,
              JSON.stringify({
                diagnostic: 'managed-cwd-save',
                shape,
                count,
                valid,
                savesBefore: effectBefore[1],
                writes: host.metadataWrites
              })
            ).toBe(effectBefore[1])
            expect(output.error).toEqual({
              code: 'LINEAGE_PARENT_AMBIGUOUS',
              message: formatAmbiguousCwdParentMessage('codex')
            })
            expect(output.error.message).toHaveLength(637)
            expect(host.publish.mock.calls.length).toBe(effectBefore[2])
          }
          const row = openTestJournalHostDatabase(stateDirectory)
            .db.prepare('SELECT row_json FROM agent_session_operations ORDER BY rowid DESC LIMIT 1')
            .get()
          expect(typeof row?.row_json).toBe('string')
          const rowJson = String(row!.row_json)
          expect(JSON.parse(rowJson).outcome.status).toBe(valid ? 'succeeded' : 'failed')
          expect(rowJson).not.toContain('cwdParentAmbiguous')
          expect(rowJson).not.toContain('workspaces')
          const prettyJsonBytes = Buffer.byteLength(log.mock.calls.flat().join('\n'))
          const originalReply = replies.at(-1)!
          const { _meta: _originalMeta, ...replyBody } = JSON.parse(originalReply)
          originals.set(operationId, { reply: replyBody, row: rowJson })
          const normalizedReplyBytes = Buffer.byteLength(normalize(replyBody, operationId))
          const normalizedRowBytes = Buffer.byteLength(normalize(JSON.parse(rowJson), operationId))
          log.mockClear()
          error.mockClear()
          process.exitCode = prior
          await main([...argv, '--retry-launch', operationId], parent.path)
          const text = (valid ? log : error).mock.calls.flat().join('\n')
          expect(
            valid
              ? text.includes('term_started')
              : text === formatAmbiguousCwdParentMessage('codex')
          ).toBe(true)
          expect(settledExecution.at(-1)).toEqual(Array(8).fill(0))
          samples.push({
            count,
            valid,
            operations: measuredOperations,
            elapsedMs,
            jsonBytes,
            frameBytes,
            replyBytes: Buffer.byteLength(originalReply),
            rowBytes: Buffer.byteLength(rowJson),
            reopenedReplyBytes: 0,
            textBytes: Buffer.byteLength(text),
            prettyJsonBytes,
            normalizedReplyBytes,
            normalizedRowBytes
          })
        }
        await closeTestJournalHostDatabase(stateDirectory)
        records = await openTestAgentSessionRecordStore(stateDirectory)
        const restarted = new OrcaRuntimeService(host.runtimeStore)
        vi.spyOn(restarted, 'openAgentSessionRecordStore').mockResolvedValue(records)
        const executionSpies = [
          vi.spyOn(restarted, 'createManagedWorktree'),
          vi.spyOn(restarted, 'showTerminal'),
          vi.spyOn(restarted, 'listManagedWorktrees'),
          vi.spyOn(restarted, 'showRepo'),
          vi.spyOn(restarted, 'createTerminal'),
          vi.spyOn(restarted, 'publishAgentLaunchTab')
        ]
        execution = () => [
          lineage.mock.calls.length,
          ...executionSpies.map((spy) => spy.mock.calls.length),
          host.save.mock.calls.length
        ]
        dispatcher = new RpcDispatcher({
          runtime: restarted,
          methods: [...AGENT_LAUNCH_METHODS, ...WORKTREE_METHODS]
        })
        for (const [index, operationId] of operationIds.entries()) {
          process.env.ORCA_TERMINAL_HANDLE = index === 0 ? host.caller : 'term_X'
          log.mockClear()
          error.mockClear()
          process.exitCode = prior
          await main([...argv, '--retry-launch', operationId, '--json'], parent.path)
          const result = JSON.parse(log.mock.calls.flat().join('\n'))
          const { _meta: _reopenedMeta, ...replyBody } = JSON.parse(replies.at(-1)!)
          expect(replyBody).toEqual(originals.get(operationId)!.reply)
          expect(settledExecution.at(-1)).toEqual(Array(8).fill(0))
          const persisted = openTestJournalHostDatabase(stateDirectory)
            .db.prepare('SELECT row_json FROM agent_session_operations')
            .all()
            .map((row) => String(row.row_json))
          expect(persisted).toContain(originals.get(operationId)!.row)
          expect(result.ok).toBe(index === 0)
          if (index === 1) {
            expect(result.error.message).toBe(formatAmbiguousCwdParentMessage('codex'))
          }
          samples.findLast(
            (sample) => sample.count === count && sample.valid === (index === 0)
          )!.reopenedReplyBytes = Buffer.byteLength(replies.at(-1)!)
        }
        expect(host.start).toHaveBeenCalledTimes(1)
        expect(host.create).toHaveBeenCalledTimes(2)
        await transport.stop()
        await closeTestJournalHostDatabase(stateDirectory)
        lineage.mockRestore()
      }
      for (const valid of [true, false]) {
        const pair = samples.filter((sample) => sample.valid === valid)
        expect(pair[1]!.operations).toBeLessThanOrEqual(11 * pair[0]!.operations)
        // Raw sizes above retain generated IDs/meta; only fixed request shape is compared across N.
        expect(pair[1]!.frameBytes).toBe(pair[0]!.frameBytes)
        expect(pair[1]!.normalizedReplyBytes).toBe(pair[0]!.normalizedReplyBytes)
        expect(pair[1]!.normalizedRowBytes).toBe(pair[0]!.normalizedRowBytes)
      }
      console.info(
        'managed-cwd-benchmark',
        JSON.stringify({
          platform: process.platform,
          node: process.version,
          base: '3bfcda1bf043af8d83371b2f131a65f2056f7970',
          shape,
          boundary:
            'CLI catalog already supplied; real managed creation; external Git/terminal effects substituted; each N uses new runtime/store/socket after corpus setup; T is first trigger, X and receipt replays reuse warmed runtime; modules already loaded',
          samples
        })
      )
    }
  )
})
