import { expect, it, vi } from 'vitest'
import type { PtyProcessInfo } from '../../../providers/pty/process-info'
import { identityFixture } from './terminal-identity.test-fixture'
import {
  store,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import { terminalsProvenAbsent } from '../../rpc/methods/orchestration/worker/session-worker-terminal-presence'
import { createInventoryRuntime, deferred } from '../lifecycle/pty-inventory-lifecycle-fixture'

const worker = {
  liveness: { verdict: 'unverifiable', reason: 'missing_status' },
  host: { kind: 'local', id: 'local' }
} as const
const durable = {
  agentTerminalHandle: 'term_recorded',
  paneKey: 'tab-old:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resource: {
    id: 'resource-restored',
    ownerDispatchId: 'dispatch-restored',
    worktreeId: TEST_WORKTREE_ID,
    paneKey: 'tab-old:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ownershipState: 'owned',
    releaseState: 'held',
    updatedAt: '2026-11-11T00:00:00Z',
    processIncarnation: 'pty-restored:original',
    hostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
  }
}

it('keeps a controller-owned worker open when its graph is published before PTY adoption', async () => {
  const { runtime } = identityFixture()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [
      {
        id: 'pty-restored',
        incarnationId: 'original',
        terminalHandle: 'term_recorded',
        title: 'codex',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        wslDistro: null
      }
    ]
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })

  expect(await terminalsProvenAbsent(runtime, [{ worker, durable }])).toEqual([false])
  await runtime.listAllMobileSessionTabsInventory()
  expect(await terminalsProvenAbsent(runtime, [{ worker, durable }])).toEqual([false])
})

it('does not declare an absent worker from a published graph without a PTY census', async () => {
  const { runtime } = identityFixture()
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
  expect(await terminalsProvenAbsent(runtime, [{ worker, durable }])).toEqual([false])
})

it('declares a missing worker ended only after a complete empty controller census', async () => {
  const { runtime } = identityFixture()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
  expect(await terminalsProvenAbsent(runtime, [{ worker, durable }])).toEqual([true])
})

function emptyCensusRuntime(runtimeStore?: Parameters<typeof identityFixture>[1]) {
  const { runtime } = identityFixture(undefined, runtimeStore)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
  return runtime
}

it('identifies every absent terminal in a batch of workers', async () => {
  const runtime = emptyCensusRuntime()
  const verdicts = await terminalsProvenAbsent(runtime, [
    { worker, durable },
    { worker, durable: { ...durable, agentTerminalHandle: 'term_second' } },
    { worker, durable: { ...durable, agentTerminalHandle: 'term_third' } }
  ])
  expect(verdicts).toEqual([true, true, true])
})

it('never calls a worker on another host or with a status row missing, even beside one the census proves gone', async () => {
  const runtime = emptyCensusRuntime()
  const verdicts = await terminalsProvenAbsent(runtime, [
    { worker: { ...worker, host: { kind: 'remote', id: 'ssh:box' } }, durable },
    {
      worker: { ...worker, liveness: { verdict: 'unverifiable', reason: 'host_unavailable' } },
      durable
    },
    { worker, durable }
  ])
  expect(verdicts).toEqual([false, false, true])
})

it('cannot prove that a worker on a different host is absent', async () => {
  const runtime = emptyCensusRuntime()
  expect(
    await terminalsProvenAbsent(runtime, [
      { worker: { ...worker, host: { kind: 'remote', id: 'ssh:box' } }, durable }
    ])
  ).toEqual([false])
})

it('keeps the worker unconfirmed when its controller changes after the census', async () => {
  const runtime = emptyCensusRuntime()
  const refresh = runtime.refreshAuthoritativeTerminalInventory.bind(runtime)
  vi.spyOn(runtime, 'refreshAuthoritativeTerminalInventory').mockImplementation(async () => {
    const census = await refresh()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    return census
  })
  expect(await terminalsProvenAbsent(runtime, [{ worker, durable }])).toEqual([false])
})

it('takes one local census for repeated reads while its controller and graph hold', async () => {
  const runtime = emptyCensusRuntime()
  const listProcesses = vi.fn(async () => [])
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses
  })
  const reads = await Promise.all(
    [0, 1, 2].map(() => terminalsProvenAbsent(runtime, [{ worker, durable }]))
  )
  expect(await terminalsProvenAbsent(runtime, [{ worker, durable }])).toEqual([true])
  expect(reads).toEqual([[true], [true], [true]])
  expect(listProcesses).toHaveBeenCalledTimes(1)
  expect(listProcesses).toHaveBeenCalledWith('local', expect.anything())

  runtime.markRendererReloading(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
  await terminalsProvenAbsent(runtime, [{ worker, durable }])
  expect(listProcesses).toHaveBeenCalledTimes(2)
})

it('keeps a worker with no host scope unconfirmed while an SSH host is known', async () => {
  const unscoped = {
    worker,
    durable: { ...durable, resource: { ...durable.resource, hostScope: null } }
  }
  const sshKnown = emptyCensusRuntime({
    ...store,
    getWorkspaceSessionHostIds: () => ['local', 'ssh:box']
  })
  expect(await terminalsProvenAbsent(sshKnown, [unscoped, { worker, durable }])).toEqual([
    false,
    true
  ])
  expect(await terminalsProvenAbsent(emptyCensusRuntime(), [unscoped])).toEqual([true])
})

it('takes a fresh census once a cached one ages out, so a PTY found later keeps its worker open', async () => {
  const runtime = emptyCensusRuntime()
  const listed: PtyProcessInfo[] = []
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => listed
  })
  const now = vi.spyOn(performance, 'now').mockReturnValue(10_000)
  expect(await terminalsProvenAbsent(runtime, [{ worker, durable }])).toEqual([true])
  listed.push({
    id: 'pty-restored',
    incarnationId: 'original',
    terminalHandle: 'term_recorded',
    title: 'codex',
    cwd: TEST_WORKTREE_PATH,
    worktreeId: TEST_WORKTREE_ID,
    wslDistro: null
  })
  now.mockReturnValue(10_500)
  expect(await terminalsProvenAbsent(runtime, [{ worker, durable }])).toEqual([true])
  now.mockReturnValue(11_000)
  expect(await terminalsProvenAbsent(runtime, [{ worker, durable }])).toEqual([false])
  now.mockRestore()
})

it('takes a fresh census for the next read after a controller swap', async () => {
  const runtime = emptyCensusRuntime()
  expect(await terminalsProvenAbsent(runtime, [{ worker, durable }])).toEqual([true])
  const listProcesses = vi.fn(async () => [])
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses
  })
  expect(await terminalsProvenAbsent(runtime, [{ worker, durable }])).toEqual([true])
  expect(listProcesses).toHaveBeenCalledTimes(1)
})

it('leaves an all-hosts inventory still in flight current', async () => {
  const aggregate = deferred<PtyProcessInfo[]>()
  const { runtime } = createInventoryRuntime(async (hostId) =>
    hostId === undefined ? aggregate.promise : []
  )
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
  const pending = runtime.read(undefined)
  expect(await runtime.refreshAuthoritativeTerminalInventory()).not.toBeNull()
  aggregate.resolve([])
  expect(await pending).not.toBeNull()
})
