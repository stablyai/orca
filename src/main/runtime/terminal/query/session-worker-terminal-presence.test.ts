import { expect, it, vi } from 'vitest'
import { identityFixture } from './terminal-identity.test-fixture'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import { terminalsProvenAbsent } from '../../rpc/methods/orchestration/worker/session-worker-terminal-presence'

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

function emptyCensusRuntime() {
  const { runtime } = identityFixture()
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
