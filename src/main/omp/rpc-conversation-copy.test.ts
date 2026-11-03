import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import { FakeConnection, state } from '../pi/rpc-session-adapter.test-fixture'
import type { PiRpcSessionAdapterDeps } from '../pi/rpc-session-contract'
import { OMP_RPC_AGENT } from './rpc-agent-definition'
import { OmpRpcSessionAdapter } from './rpc-session-adapter'
import { OmpRpcConversationCopies } from './rpc-conversation-copies'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  await closeProviderTimelineRigs()
})

async function setup(legacy = false) {
  const root = await mkdtemp(join(tmpdir(), 'omp-copy-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const sourceId = '01a00000-0000-7000-8000-000000000001'
  const copyId = '01a00000-0000-7000-8000-000000000002'
  const source = join(root, `2026-11-03T00-00-00-000Z_${sourceId}.jsonl`)
  const copy = join(root, `2026-11-03T00-00-01-000Z_${copyId}.jsonl`)
  const header = (id: string) =>
    `${JSON.stringify({ type: 'title', v: 1, title: 'Saved chat' })}\n${JSON.stringify({ type: 'session', version: 3, id, cwd: root })}\n`
  await writeFile(source, header(sourceId))
  const previous: AgentSessionProviderHandleLink = {
    linkId: 'original',
    handle: {
      agent: 'omp',
      transport: legacy ? 'acp' : 'jsonl-rpc',
      nativeId: legacy ? sourceId : source
    },
    origin: 'created',
    mintedAtFence: 1,
    observedAt: 1
  }
  const connections: FakeConnection[] = []
  const resolveLaunch = vi.fn<PiRpcSessionAdapterDeps['resolveLaunch']>(async () => ({
    command: 'omp',
    cwd: root,
    fullAccess: true,
    previous,
    sessionFile: source,
    env: { PI_CODING_AGENT_DIR: root, ORCA_AGENT_SESSION_ID: 'original-chat' }
  }))
  const openConnection = vi.fn<NonNullable<PiRpcSessionAdapterDeps['openConnection']>>(
    (launch, handlers) => {
      const connection = new FakeConnection(handlers)
      connection.requestOverride = launch.args.includes('--fork')
        ? async () => {
            await writeFile(copy, header(copyId))
            return { ...state, sessionId: copyId, sessionFile: copy }
          }
        : (command) =>
            command === 'get_state'
              ? Promise.resolve({ ...state, sessionId: sourceId, sessionFile: source })
              : undefined
      connections.push(connection)
      return connection
    }
  )
  const deps: PiRpcSessionAdapterDeps = {
    resolveLaunch,
    openConnection,
    readProcessStartTime: async () => 1,
    onLifecycle: vi.fn(),
    onSettled: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn() }
  }
  const adapter = new OmpRpcSessionAdapter(deps)
  cleanups.push(() => adapter.closeAll())
  const identity = {
    sessionId: 'omp-test',
    agent: 'omp',
    hostId: 'local',
    workspaceId: 'folder',
    providerHandle: previous.handle
  }
  const input = {
    identity,
    providerSessionId: previous.handle.nativeId,
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: root }
  }
  return {
    root,
    source,
    sourceId,
    copy,
    copyId,
    header,
    adapter,
    identity,
    input,
    connections,
    deps,
    resolveLaunch,
    openConnection
  }
}

it('routes terminal continuation to an independent OMP conversation copy', async () => {
  const h = await setup()
  const { adapter } = h
  const rig = await openProviderTimelineRig({ agent: 'omp', sessionId: 'omp-test' })
  const acquired = await adapter.acquire({
    identity: h.identity,
    fence: 1,
    spawnToken: 'live',
    events: rig.eventSink
  })
  await adapter.open({
    sessionId: 'omp-test',
    fence: 1,
    acquisitionGeneration: acquired.acquisitionGeneration,
    signal: new AbortController().signal
  })
  const original = await readFile(h.source, 'utf8')
  const router = new StructuredAgentSessionAdapterRouter(
    new StructuredAgentRegistry([{ definition: OMP_RPC_AGENT, adapter }]),
    () => adapter.closeAll()
  )
  await expect(router.copyConversation(h.input)).resolves.toEqual({
    sessionId: h.copyId,
    filePath: h.copy
  })
  expect(h.connections).toHaveLength(2)
  expect(h.connections[0]!.closed).toBe(false)
  expect(h.connections[0]!.requests).not.toContain('fork')
  expect(h.connections[1]!.closed).toBe(true)
  expect(await readFile(h.source, 'utf8')).toBe(original)
  const launch = h.openConnection.mock.calls[1]![0]
  expect(launch.args).toContain('--fork')
  expect(launch.args).not.toContain('--session')
  expect(launch.env).not.toHaveProperty('ORCA_AGENT_SESSION_ID')
  const config = launch.args.at(-3)!
  await expect(readFile(config, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('copies an at-rest legacy ACP handle through its resolved RPC file', async () => {
  const h = await setup(true)
  await expect(h.adapter.copyConversation(h.input)).resolves.toEqual({
    sessionId: h.copyId,
    filePath: h.copy
  })
  expect(h.openConnection.mock.calls[0]![0].args.slice(-2)).toEqual(['--fork', h.source])
  expect(h.connections[0]!.closed).toBe(true)
})

it('refuses an account or conversation change before starting a child', async () => {
  const h = await setup()
  await expect(
    h.adapter.copyConversation({
      ...h.input,
      accountHome: { variable: 'PI_CODING_AGENT_DIR', path: join(h.root, 'other') }
    })
  ).rejects.toThrow('account')
  await expect(
    h.adapter.copyConversation({ ...h.input, providerSessionId: 'stale' })
  ).rejects.toThrow('changed')
  expect(h.openConnection).not.toHaveBeenCalled()
})

it('rejects an unchanged identity or unsaved copy and closes the copy child', async () => {
  const h = await setup()
  h.openConnection.mockImplementation((_launch, handlers) => {
    const connection = new FakeConnection(handlers)
    connection.requestOverride = async () => ({ sessionId: h.sourceId, sessionFile: h.source })
    h.connections.push(connection)
    return connection
  })
  await expect(h.adapter.copyConversation(h.input)).rejects.toThrow('original conversation')
  expect(h.connections[0]!.closed).toBe(true)
  h.openConnection.mockImplementation((_launch, handlers) => {
    const connection = new FakeConnection(handlers)
    connection.requestOverride = async () => ({ sessionId: h.copyId, sessionFile: h.copy })
    h.connections.push(connection)
    return connection
  })
  await expect(h.adapter.copyConversation(h.input)).rejects.toThrow('valid conversation copy')
  expect(h.connections[1]!.closed).toBe(true)
})

it('cancels an unanswered copy on shutdown without affecting the source', async () => {
  const h = await setup()
  const started = Promise.withResolvers<void>()
  h.openConnection.mockImplementation((_launch, handlers) => {
    const connection = new FakeConnection(handlers)
    connection.requestOverride = () => {
      started.resolve()
      return new Promise(() => {})
    }
    h.connections.push(connection)
    return connection
  })
  const copying = expect(h.adapter.copyConversation(h.input)).rejects.toThrow()
  await started.promise
  await h.adapter.closeAll()
  await copying
  expect(h.connections[0]!.closed).toBe(true)
  expect(await readFile(h.source, 'utf8')).toBe(h.header(h.sourceId))
})

it('closes a copy that exceeds its deadline', async () => {
  const h = await setup()
  const copies = new OmpRpcConversationCopies(h.deps)
  cleanups.push(() => copies.closeAll())
  const deadline = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  const started = Promise.withResolvers<void>()
  h.openConnection.mockImplementation((_launch, handlers) => {
    const connection = new FakeConnection(handlers)
    connection.requestOverride = () => {
      started.resolve()
      return new Promise(() => {})
    }
    h.connections.push(connection)
    return connection
  })
  try {
    const copying = expect(copies.copy(h.input)).rejects.toThrow('Copy timed out')
    await started.promise
    deadline.abort(new Error('Copy timed out'))
    await copying
    expect(h.connections[0]!.closed).toBe(true)
  } finally {
    timeout.mockRestore()
  }
})

it('retains an unproven copy child and retries cleanup on shutdown', async () => {
  const h = await setup()
  h.openConnection.mockImplementation((_launch, handlers) => {
    const connection = new FakeConnection(handlers)
    connection.closeResult = { root: 'unverifiable', tree: 'unverifiable' }
    connection.requestOverride = async () => {
      await writeFile(h.copy, h.header(h.copyId))
      return { sessionId: h.copyId, sessionFile: h.copy }
    }
    h.connections.push(connection)
    return connection
  })
  await expect(h.adapter.copyConversation(h.input)).rejects.toThrow('could not release')
  const close = vi.spyOn(h.connections[0]!, 'close')
  h.connections[0]!.closeResult = { root: 'exited', tree: 'exited' }
  await h.adapter.closeAll()
  expect(close).toHaveBeenCalledOnce()
})
