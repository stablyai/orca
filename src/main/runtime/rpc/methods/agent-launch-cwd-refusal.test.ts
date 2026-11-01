import '../unused-default-rpc-methods.test-fixture'
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

vi.mock('../../../../cli/runtime-client', async () => {
  const harnessPath = '../../../../cli/index-test-harness.js'
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

vi.mock('../../../../cli/runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

import { createConnection } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  main,
  configureWorktreeAwarenessEnvironment,
  buildWorktree,
  okFixture,
  worktreeListFixture,
  agentLaunchHostFixture,
  type RuntimeClientModuleMockFactory
} from './agent-launch-cwd-cli.test-fixture'
import { RuntimeRpcFailureError } from '../../../../cli/runtime/types'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITIES,
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
import { RpcDispatcher } from '../dispatcher'
import { UnixSocketTransport } from '../unix-socket-transport'
import { AGENT_LAUNCH_METHODS } from './agent-launch'
import { WORKTREE_METHODS } from './worktree'
import {
  OrcaRuntimeService,
  addWorktree,
  listWorktrees,
  MOCK_GIT_WORKTREES
} from '../../orca-runtime-test-mocks.spec'
import '../../orca-runtime-test-lifecycle.spec'
import {
  store as runtimeStore,
  TEST_WORKTREE_ID,
  createFolderWorkspaceRuntimeStore,
  makeFolderWorkspace
} from '../../orca-runtime-test-fixtures.spec'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore
} from '../../agent-session/records/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { setAgentLaunchRecordStore } from './agent-launch.test-fixture'
import { RuntimeWorktreeLineageController } from '../../runtime-worktree-lineage-controller'
import * as createdWorkspaceLaunch from '../../../agent-launch/agent-launch-created-workspace'
import { formatAmbiguousCwdParentMessage } from '../../runtime-worktree-lineage-resolution'
import { managedCwdMobileFixture } from './managed-cwd-mobile.test-fixture'
import { managedCwdLaunchFixture } from './managed-cwd-launch.test-fixture'
import { computeAgentLaunchFingerprint } from '../../../../shared/agent-launch-operation'
import { AgentLaunchReplay } from '../../../../shared/rpc-contract/agent-launch-params'

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

describe('CLI cwd refusal through production creation and durable failed receipt', () => {
  let directory: string
  let transport: UnixSocketTransport
  let prior: typeof process.exitCode
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
    await transport?.stop()
    setAgentLaunchRecordStore(null)
    await closeTestJournalHostDatabase(directory)
    await rm(directory, { recursive: true, force: true })
    process.exitCode = prior
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it.each([
    'worktree.create',
    'agent.launchReplay',
    'agent.launch',
    'legacy',
    'structured'
  ] as const)('keeps original code/text once through %s and actual close/reopen', async (route) => {
    const records = await openTestAgentSessionRecordStore(directory)
    const rpcRoute = route === 'structured' ? 'agent.launchReplay' : route
    const runtime = new OrcaRuntimeService(runtimeStore)
    vi.spyOn(runtime, 'openAgentSessionRecordStore').mockResolvedValue(records)
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
      ...runtime.getClientSettings()
    })
    vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const releases: ReturnType<typeof vi.fn>[] = []
    const begin = createdWorkspaceLaunch.beginCreatedWorkspaceLaunch
    vi.spyOn(createdWorkspaceLaunch, 'beginCreatedWorkspaceLaunch').mockImplementation(
      (owner, agent) => {
        const launch = begin(owner, agent)
        const release = vi.fn(launch.release)
        releases.push(release)
        return { ...launch, release }
      }
    )
    const create = vi.spyOn(runtime, 'createManagedWorktree')
    const showTerminal = vi
      .spyOn(runtime, 'showTerminal')
      .mockRejectedValue(new Error('terminal_not_found'))
    const start = vi.spyOn(runtime, 'createTerminal')
    const meta = vi.spyOn(runtimeStore, 'setWorktreeMeta')
    const publish = vi.spyOn(runtime, 'publishAgentLaunchTab')
    const endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\orca-cwd-${randomUUID()}`
        : join(directory, 'rpc.sock')
    transport = new UnixSocketTransport({
      endpoint,
      kind: process.platform === 'win32' ? 'named-pipe' : 'unix'
    })
    let dispatcher = new RpcDispatcher({
      runtime,
      methods: [...AGENT_LAUNCH_METHODS, ...WORKTREE_METHODS]
    })
    const envelopes: { method: string; params: Record<string, unknown> }[] = []
    transport.onMessage((raw, reply) => {
      const request = JSON.parse(raw)
      envelopes.push(request)
      void dispatcher.dispatch(request).then((response) => reply(JSON.stringify(response)))
    })
    await transport.start()
    const root = buildWorktree(MOCK_GIT_WORKTREES[0]!.path, 'main', 'abc', 'repo-1')
    expect(root.id).toBe(TEST_WORKTREE_ID)
    const sibling = { ...root, id: `${root.id}::workspace:11111111-1111-4111-8111-111111111111` }
    let catalog = [root, sibling]
    const replies: string[] = []
    callMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'worktree.list') {
        return worktreeListFixture(catalog)
      }
      if (method === 'status.get') {
        return route === 'legacy'
          ? okFixture('status', { capabilities: [] })
          : route === 'agent.launch'
            ? okFixture('status', {
                capabilities: AGENT_LAUNCH_RUNTIME_CAPABILITIES.filter(
                  (cap) => cap !== AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY
                )
              })
            : agentLaunchHostFixture()
      }
      const raw = await socketCall(
        endpoint,
        `${JSON.stringify({ id: 'request', authToken: 'fixture', method, params })}\n`
      )
      replies.push(raw)
      const response = JSON.parse(raw)
      if (!response.ok) {
        throw new RuntimeRpcFailureError(response)
      }
      return response
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const args = [
      'worktree',
      'create',
      '--repo',
      'id:repo-1',
      '--name',
      'child',
      ...(route === 'worktree.create' ? [] : ['--agent', 'codex']),
      ...(route === 'structured' ? ['--surface', 'chat'] : [])
    ]
    process.env.ORCA_TERMINAL_HANDLE = 'term_X'
    const message = formatAmbiguousCwdParentMessage(
      route === 'worktree.create' ? undefined : 'codex'
    )
    for (const json of [false, true]) {
      log.mockClear()
      err.mockClear()
      process.exitCode = prior
      await main(
        [
          ...args,
          ...(json && rpcRoute === 'agent.launchReplay'
            ? ['--retry-launch', String(envelopes[0]?.params.operationId)]
            : []),
          ...(json ? ['--json'] : [])
        ],
        root.path
      )
      expect(process.exitCode, [...log.mock.calls, ...err.mock.calls].flat().join(' ')).toBe(1)
      const output = (json ? log : err).mock.calls.flat().join('\n')
      if (json) {
        expect(JSON.parse(output).error).toEqual({ code: 'LINEAGE_PARENT_AMBIGUOUS', message })
      } else {
        expect(output).toBe(message)
      }
      expect(output).not.toContain('Next step:')
      expect(output).not.toContain('orca repo list')
      expect(output).not.toContain('could not confirm the launch')
    }
    expect(create).toHaveBeenCalled()
    expect(create.mock.calls[0]?.[0].lineage).toMatchObject({
      cwdParentWorktree: `id:${root.id}`,
      cwdParentAmbiguous: true,
      callerTerminalHandle: 'term_X'
    })
    expect(addWorktree).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(meta).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    if (route === 'structured') {
      expect(releases).toHaveLength(1)
      expect(releases[0]).toHaveBeenCalledTimes(1)
      expect(createdWorkspaceLaunch.readCreatedWorkspaceLaunch(runtime, root.id)).toBeUndefined()
    }
    if (rpcRoute !== 'agent.launchReplay') {
      return
    }
    const envelope = envelopes.find(({ method }) => method === rpcRoute)
    expect(envelope).toBeDefined()
    if (route === 'agent.launchReplay') {
      const creates = create.mock.calls.length
      const lineageReads = showTerminal.mock.calls.length
      const rows = records.listOperationRows().length
      for (const value of [false, null, 'true', 1, [], {}]) {
        const malformed = JSON.parse(JSON.stringify(envelope))
        malformed.params.target.create.cwdParentAmbiguous = value
        const response = JSON.parse(
          await socketCall(
            endpoint,
            `${JSON.stringify({ ...malformed, id: 'malformed', authToken: 'fixture' })}\n`
          )
        )
        expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
      }
      expect(create).toHaveBeenCalledTimes(creates)
      expect(showTerminal).toHaveBeenCalledTimes(lineageReads)
      expect(records.listOperationRows()).toHaveLength(rows)
    }
    const persisted = await readPersistedTestAgentSessionStore(directory)
    const row = Object.values(persisted.operations)[0]!
    expect(row.outcome).toEqual({ status: 'failed', code: 'LINEAGE_PARENT_AMBIGUOUS', message })
    expect(JSON.stringify(row)).not.toContain('cwdParentAmbiguous')
    const optionalId = `${Date.now()}-${randomUUID().replaceAll('-', '')}`
    const optional = JSON.parse(
      await socketCall(
        endpoint,
        `${JSON.stringify({ id: 'request', authToken: 'fixture', method: 'agent.launch', params: { ...envelope!.params, operationId: optionalId } })}\n`
      )
    )
    expect(optional.error).toEqual({ code: 'LINEAGE_PARENT_AMBIGUOUS', message })
    expect(
      records.listOperationRows().find((entry) => entry.operationId === optionalId)?.outcome
    ).toEqual(row.outcome)
    const { operationId: _optionalId, ...withoutOperationId } = envelope!.params
    const beforeNoId = records.listOperationRows().length
    expect(
      JSON.parse(
        await socketCall(
          endpoint,
          `${JSON.stringify({
            id: 'no-id',
            authToken: 'fixture',
            method: 'agent.launch',
            params: withoutOperationId
          })}\n`
        )
      ).error
    ).toEqual({ code: 'LINEAGE_PARENT_AMBIGUOUS', message })
    expect(records.listOperationRows()).toHaveLength(beforeNoId)
    expect(addWorktree).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(meta).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    await closeTestJournalHostDatabase(directory)
    const reopened = await openTestAgentSessionRecordStore(directory)
    const restarted = new OrcaRuntimeService(runtimeStore)
    vi.spyOn(restarted, 'openAgentSessionRecordStore').mockResolvedValue(reopened)
    const replayCreate = vi.spyOn(restarted, 'createManagedWorktree')
    const replayTerminal = vi.spyOn(restarted, 'showTerminal')
    const replayCatalog = vi.spyOn(restarted, 'listManagedWorktrees')
    const replayStart = vi.spyOn(restarted, 'createTerminal')
    const replayPublish = vi.spyOn(restarted, 'publishAgentLaunchTab')
    dispatcher = new RpcDispatcher({ runtime: restarted, methods: AGENT_LAUNCH_METHODS })
    catalog = [root]
    const originalId = String(envelope!.params.operationId)
    const createCalls = create.mock.calls.length
    for (const json of [false, true]) {
      log.mockClear()
      err.mockClear()
      process.exitCode = prior
      await main([...args, '--retry-launch', originalId, ...(json ? ['--json'] : [])], root.path)
      expect(process.exitCode).toBe(1)
      const output = (json ? log : err).mock.calls.flat().join('\n')
      if (json) {
        expect(JSON.parse(output).error).toEqual({ code: 'LINEAGE_PARENT_AMBIGUOUS', message })
      } else {
        expect(output).toBe(message)
      }
      const { _meta: _originalMeta, ...original } = JSON.parse(replies[0]!)
      const { _meta: _reopenedMeta, ...replayed } = JSON.parse(replies.at(-1)!)
      expect(replayed).toEqual(original)
    }
    expect(create).toHaveBeenCalledTimes(createCalls)
    expect(reopened.listOperationRows()[0]?.outcome).toEqual(row.outcome)
    expect(replayCreate).not.toHaveBeenCalled()
    expect(replayTerminal).not.toHaveBeenCalled()
    expect(replayCatalog).not.toHaveBeenCalled()
    expect(replayStart).not.toHaveBeenCalled()
    expect(replayPublish).not.toHaveBeenCalled()
    expect(showTerminal).toHaveBeenCalled()
    const failedWriteId = `${Date.now()}-${randomUUID().replaceAll('-', '')}`
    const failingHost = new OrcaRuntimeService(runtimeStore)
    vi.spyOn(failingHost, 'openAgentSessionRecordStore').mockResolvedValue(reopened)
    vi.spyOn(failingHost, 'getClientSettings').mockReturnValue({
      ...failingHost.getClientSettings()
    })
    vi.spyOn(failingHost, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    vi.spyOn(failingHost, 'showTerminal').mockRejectedValue(new Error('terminal_not_found'))
    vi.spyOn(reopened, 'recordOperationOutcome').mockRejectedValueOnce(
      new Error('fixture write failed')
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    dispatcher = new RpcDispatcher({ runtime: failingHost, methods: AGENT_LAUNCH_METHODS })
    const failedWriteRequest = {
      id: 'request',
      authToken: 'fixture',
      method: rpcRoute,
      params: { ...envelope!.params, operationId: failedWriteId }
    }
    expect(
      JSON.parse(await socketCall(endpoint, `${JSON.stringify(failedWriteRequest)}\n`)).error
    ).toEqual({ code: 'LINEAGE_PARENT_AMBIGUOUS', message })
    await closeTestJournalHostDatabase(directory)
    const uncertainRecords = await openTestAgentSessionRecordStore(directory)
    const uncertainHost = new OrcaRuntimeService(runtimeStore)
    vi.spyOn(uncertainHost, 'openAgentSessionRecordStore').mockResolvedValue(uncertainRecords)
    const uncertainCreate = vi.spyOn(uncertainHost, 'createManagedWorktree')
    dispatcher = new RpcDispatcher({ runtime: uncertainHost, methods: AGENT_LAUNCH_METHODS })
    expect(
      JSON.parse(await socketCall(endpoint, `${JSON.stringify(failedWriteRequest)}\n`))
    ).toMatchObject({ ok: false, error: { code: 'agent_session_operation_unknown' } })
    expect(uncertainCreate).not.toHaveBeenCalled()
    expect(
      uncertainRecords.listOperationRows().find((entry) => entry.operationId === failedWriteId)
        ?.outcome.status
    ).toBe('unknown')
  })
  it('joins one real T launch across five CLI catalogs and true journal reopen', async () => {
    let records = await openTestAgentSessionRecordStore(directory)
    const root = buildWorktree('/tmp/worktree-a', 'main', 'abc', 'repo-1')
    const sibling = { ...root, id: `${root.id}::workspace:11111111-1111-4111-8111-111111111111` }
    const other = { ...root, id: `${root.id}::workspace:22222222-2222-4222-8222-222222222222` }
    let rows = [root, sibling]
    const host = managedCwdLaunchFixture(records, root, directory)
    expect(await host.runtime.showTerminal(host.caller)).toMatchObject({ worktreeId: root.id })
    host.showTerminal.mockClear()
    const lineage = vi.spyOn(RuntimeWorktreeLineageController.prototype, 'resolveCreate')
    const add = vi.mocked(addWorktree).getMockImplementation()!
    let release!: () => void
    const pendingEffect = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(addWorktree).mockImplementation(async (...args) => {
      await pendingEffect
      return add(...args)
    })
    let dispatcher = new RpcDispatcher({
      runtime: host.runtime,
      methods: [...AGENT_LAUNCH_METHODS, ...WORKTREE_METHODS]
    })
    const endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\orca-t-${randomUUID()}`
        : join(directory, 't.sock')
    transport = new UnixSocketTransport({
      endpoint,
      kind: process.platform === 'win32' ? 'named-pipe' : 'unix'
    })
    const frames: { method: string; params: Record<string, unknown> }[] = []
    const outcomes: unknown[] = []
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
      frames.push(request)
      const before = execution()
      void dispatcher.dispatch(request).then((response) => {
        if (request.method === 'agent.launchReplay') {
          outcomes.push(response.ok ? response.result : response.error)
          settledExecution.push(execution().map((n, i) => n - before[i]!))
        }
        reply(JSON.stringify(response))
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
      const response = JSON.parse(
        await socketCall(
          endpoint,
          `${JSON.stringify({ id: 't', authToken: 'fixture', method, params })}\n`
        )
      )
      if (!response.ok) {
        throw new RuntimeRpcFailureError(response)
      }
      return response
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env.ORCA_TERMINAL_HANDLE = host.caller
    const argv = [
      'worktree',
      'create',
      '--repo',
      'id:repo-1',
      '--name',
      'child',
      '--agent',
      'codex',
      '--prompt',
      'hello',
      '--json'
    ]
    const initial = main(argv, root.path)
    await vi.waitFor(() => expect(addWorktree).toHaveBeenCalledTimes(1))
    expect(await lineage.mock.results[0]?.value).toMatchObject({
      kind: 'lineage',
      capture: { source: 'terminal-context' },
      createdByTerminalHandle: host.caller
    })
    const first = frames.find((frame) => frame.method === 'agent.launchReplay')!
    const operationId = String(first.params.operationId)
    rows = [root, sibling, other]
    const joined = main([...argv, '--retry-launch', operationId], root.path)
    await vi.waitFor(() =>
      expect(frames.filter((frame) => frame.method === 'agent.launchReplay')).toHaveLength(2)
    )
    release()
    await Promise.all([initial, joined])
    expect(process.exitCode, error.mock.calls.flat().join('\n')).toBe(prior)
    expect(outcomes[1]).toEqual(outcomes[0])
    expect(host.lineage.get(host.childId)).toMatchObject({
      parentWorktreeId: root.id,
      createdByTerminalHandle: host.caller,
      capture: { source: 'terminal-context' }
    })
    for (const catalog of [[root, other, sibling], [root]]) {
      rows = catalog
      await main([...argv, '--retry-launch', operationId], root.path)
      expect(outcomes.at(-1)).toEqual(outcomes[0])
      expect(settledExecution.at(-1)).toEqual(Array(8).fill(0))
    }
    await closeTestJournalHostDatabase(directory)
    records = await openTestAgentSessionRecordStore(directory)
    const restarted = new OrcaRuntimeService(host.runtimeStore)
    vi.spyOn(restarted, 'openAgentSessionRecordStore').mockResolvedValue(records)
    const replayCreate = vi.spyOn(restarted, 'createManagedWorktree')
    const replayTerminal = vi.spyOn(restarted, 'showTerminal')
    const replayPublish = vi.spyOn(restarted, 'publishAgentLaunchTab')
    const replayRepo = vi.spyOn(restarted, 'showRepo')
    const replayList = vi.spyOn(restarted, 'listManagedWorktrees')
    const replayStart = vi.spyOn(restarted, 'createTerminal')
    dispatcher = new RpcDispatcher({
      runtime: restarted,
      methods: [...AGENT_LAUNCH_METHODS, ...WORKTREE_METHODS]
    })
    execution = () => [
      lineage.mock.calls.length,
      replayTerminal.mock.calls.length,
      replayList.mock.calls.length,
      replayRepo.mock.calls.length,
      replayCreate.mock.calls.length,
      replayStart.mock.calls.length,
      replayPublish.mock.calls.length,
      host.save.mock.calls.length
    ]
    for (const catalog of [[root, sibling], [root]]) {
      rows = catalog
      await main([...argv, '--retry-launch', operationId], root.path)
      expect(process.exitCode, error.mock.calls.flat().join('\n')).toBe(prior)
      expect(outcomes.at(-1)).toEqual(outcomes[0])
      expect(settledExecution.at(-1)).toEqual(Array(8).fill(0))
      expect(host.lineage.get(host.childId)).toMatchObject({
        parentWorktreeId: root.id,
        createdByTerminalHandle: host.caller,
        capture: { source: 'terminal-context' }
      })
    }
    const launches = frames.filter((frame) => frame.method === 'agent.launchReplay')
    expect(launches).toHaveLength(6)
    const fingerprints = launches.map(({ params }) =>
      computeAgentLaunchFingerprint(AgentLaunchReplay.parse(params))
    )
    expect(new Set(fingerprints).size).toBe(1)
    expect(
      launches.map(
        ({ params }) => JSON.parse(JSON.stringify(params)).target.create.cwdParentAmbiguous
      )
    ).toEqual([true, true, true, undefined, true, undefined])
    for (const { params } of launches) {
      expect(params.operationId).toBe(operationId)
      expect(JSON.parse(JSON.stringify(params)).target.create).toMatchObject({
        cwdParentWorktree: `id:${root.id}`,
        callerTerminalHandle: host.caller
      })
    }
    for (const change of ['prompt', 'first-hint']) {
      process.exitCode = prior
      rows = change === 'first-hint' ? [sibling, root] : [root, sibling]
      const changed =
        change === 'prompt' ? argv.map((arg) => (arg === 'hello' ? 'changed' : arg)) : argv
      await main([...changed, '--retry-launch', operationId], root.path)
      expect(outcomes.at(-1)).toMatchObject({ code: 'agent_session_operation_conflict' })
    }
    expect(addWorktree).toHaveBeenCalledTimes(1)
    expect(host.create).toHaveBeenCalledTimes(1)
    expect(host.start).toHaveBeenCalledTimes(1)
    for (const spy of [replayCreate, replayTerminal, replayPublish, replayStart]) {
      expect(spy).not.toHaveBeenCalled()
    }
    expect(records.listOperationRows()).toHaveLength(1)
    expect(records.listOperationRows()[0]?.outcome.status).toBe('succeeded')
    expect(log.mock.calls.flat().join('\n')).toContain('term_started')
  })

  it('preserves original failed history through authenticated mobile crypto, admission and true reopen', async () => {
    let records = await openTestAgentSessionRecordStore(directory)
    const parent = buildWorktree('/tmp/worktree-a', 'main', 'abc', 'repo-1')
    const host = managedCwdLaunchFixture(records, parent, directory)
    const remote = managedCwdMobileFixture(host.runtime, directory)
    const phone = remote.connect('Phone')
    const operationId = () => `${Date.now()}-${randomUUID().replaceAll('-', '')}`
    const create = {
      repo: 'id:repo-1',
      name: 'child',
      cwdParentWorktree: `id:${parent.id}`,
      cwdParentAmbiguous: true
    }
    const request = (callerTerminalHandle: string, id = operationId()) => ({
      agent: 'codex',
      operationId: id,
      target: { kind: 'create-worktree', create: { ...create, callerTerminalHandle } }
    })
    try {
      const valid = await phone.send('agent.launchReplay', request(host.caller))
      expect(valid.response).toMatchObject({
        ok: true,
        result: { outcome: { kind: 'terminal', handle: 'term_started' } }
      })
      expect(host.start).toHaveBeenCalledTimes(1)
      const failedRequest = request('term_X')
      const failed = await phone.send('agent.launchReplay', failedRequest)
      const message = formatAmbiguousCwdParentMessage('codex')
      expect(failed.response).toMatchObject({
        ok: false,
        error: { code: 'LINEAGE_PARENT_AMBIGUOUS', message }
      })
      const failedEffects = [
        host.create.mock.calls.length,
        host.start.mock.calls.length,
        host.save.mock.calls.length,
        host.publish.mock.calls.length,
        host.showTerminal.mock.calls.length,
        host.catalog.mock.calls.length
      ]
      const { cwdParentAmbiguous: _observation, ...withoutObservation } =
        failedRequest.target.create
      const replayRequest = {
        ...failedRequest,
        target: { ...failedRequest.target, create: withoutObservation }
      }
      expect((await phone.send('agent.launchReplay', replayRequest)).response).toEqual(
        failed.response
      )
      expect([
        host.create.mock.calls.length,
        host.start.mock.calls.length,
        host.save.mock.calls.length,
        host.publish.mock.calls.length,
        host.showTerminal.mock.calls.length,
        host.catalog.mock.calls.length
      ]).toEqual(failedEffects)
      expect(
        records.listOperationRows().every((row) => row.callerKey === phone.device.deviceId)
      ).toBe(true)
      const other = remote.connect('Other phone')
      expect((await other.send('agent.launchReplay', failedRequest)).response).toMatchObject({
        ok: false,
        error: { code: 'LINEAGE_PARENT_AMBIGUOUS', message }
      })
      expect(
        new Set(
          records
            .listOperationRows()
            .filter((row) => row.operationId === failedRequest.operationId)
            .map((row) => row.callerKey)
        )
      ).toEqual(new Set([phone.device.deviceId, other.device.deviceId]))
      expect(
        (await phone.send('files.delete', { worktree: `id:${parent.id}`, path: 'fixture' }))
          .response
      ).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      const beforeMalformed = host.create.mock.calls.length
      expect(
        (
          await phone.send('agent.launchReplay', {
            ...request('term_X'),
            target: { kind: 'create-worktree', create: { ...create, cwdParentAmbiguous: false } }
          })
        ).response
      ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
      expect(host.create).toHaveBeenCalledTimes(beforeMalformed)
      expect(
        (await phone.send('agent.launchReplay', request(host.caller), other.device.token!)).response
      ).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
      const incapable = remote.connect('Old client', [])
      expect(
        (await incapable.send('agent.launchReplay', request(host.caller))).response
      ).toMatchObject({ ok: false, error: { code: 'agent_launch_replay_unsupported' } })
      await closeTestJournalHostDatabase(directory)
      records = await openTestAgentSessionRecordStore(directory)
      const restarted = new OrcaRuntimeService(host.runtimeStore)
      vi.spyOn(restarted, 'openAgentSessionRecordStore').mockResolvedValue(records)
      const noExecution = [
        vi.spyOn(restarted, 'createManagedWorktree'),
        vi.spyOn(restarted, 'showTerminal'),
        vi.spyOn(restarted, 'listManagedWorktrees'),
        vi.spyOn(restarted, 'showRepo'),
        vi.spyOn(restarted, 'createTerminal'),
        vi.spyOn(restarted, 'publishAgentLaunchTab')
      ]
      remote.restart(restarted)
      const reopened = await phone.send('agent.launchReplay', replayRequest)
      const { _meta: _oldMeta, ...original } = failed.response
      const { _meta: _newMeta, ...afterReopen } = reopened.response
      expect(afterReopen).toEqual(original)
      for (const spy of noExecution) {
        expect(spy).not.toHaveBeenCalled()
      }
      expect(
        records
          .listOperationRows()
          .find(
            (row) =>
              row.operationId === failedRequest.operationId &&
              row.callerKey === phone.device.deviceId
          )?.outcome
      ).toEqual({ status: 'failed', code: 'LINEAGE_PARENT_AMBIGUOUS', message })
      console.info(
        'mobile-cwd-frames',
        JSON.stringify({
          platform: process.platform,
          boundary:
            'real legacy E2EE authentication/admission, fake socket, existing launch capabilities; no paired CLI cwd producer',
          valid: valid.metrics,
          failed: failed.metrics,
          reopened: reopened.metrics
        })
      )
    } finally {
      remote.dispose()
    }
  })
  it('inspects the exact native recovery value through public CLI, RPC and actual folder resolver', async () => {
    const folder = makeFolderWorkspace({ folderPath: directory })
    const runtime = new OrcaRuntimeService(createFolderWorkspaceRuntimeStore(folder))
    const shown = vi.spyOn(runtime, 'showManagedWorktree')
    const catalog = vi.spyOn(runtime, 'listManagedWorktrees')
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
    callMock.mockImplementation(async (method, params) => {
      const response = await dispatcher.dispatch({
        id: 'native-show',
        authToken: 'fixture',
        method,
        params
      })
      if (!response.ok) {
        throw new RuntimeRpcFailureError(response)
      }
      return response
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const selector = `id:folder:${folder.id}`
    await main(['worktree', 'show', '--worktree', selector, '--json'], directory)
    expect(process.exitCode).toBe(prior)
    expect(shown).toHaveBeenCalledWith(selector)
    expect(JSON.parse(log.mock.calls.flat().join('')).result.worktree).toMatchObject({
      id: `folder:${folder.id}`,
      path: directory
    })
    expect(catalog).not.toHaveBeenCalled()
    expect(callMock.mock.calls).toEqual([['worktree.show', { worktree: selector }]])
  })
})
