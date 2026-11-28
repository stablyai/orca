import { afterEach, expect, it, vi, type MockInstance } from 'vitest'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'

// A child's queued permission writes are cut where the host admits its end, before the provider
// is told to close it; a kept child (refused close, ordinary Stop) keeps them.
let rig: QueuedMessageTestRig
let revoked: MockInstance

afterEach(async () => {
  await rig.dispose()
  vi.restoreAllMocks()
})

async function workingRig(options?: Parameters<typeof createQueuedMessageTestRig>[0]) {
  rig = await createQueuedMessageTestRig(options)
  revoked = vi.spyOn(rig.host.collaboratorsForTests().deps.adapter, 'setPermissionDispatchRevoked')
}

function expectRevokedBeforeClose(): void {
  expect(revoked).toHaveBeenCalledWith(SESSION, expect.any(Number), 'generation-1', true)
  expect(rig.closeSession).toHaveBeenCalled()
  expect(revoked.mock.invocationCallOrder[0]).toBeLessThan(
    rig.closeSession.mock.invocationCallOrder[0]
  )
}

const workspaceOf = () => rig.store.getRecord(SESSION)!.location.workspaceId

it.each([
  { cut: 'close', run: () => rig.host.close(SESSION, 'user-close') },
  {
    cut: 'admitted conditional close',
    run: () => rig.host.close(SESSION, 'user-close', () => true)
  },
  { cut: 'admitted sleep', run: () => rig.host.sleepWorkspace(workspaceOf(), true, () => true) },
  { cut: 'quit', run: () => rig.host.flushAllStreamedEvents() }
])('$cut revokes the exact child before closing it', async ({ run }) => {
  await workingRig()
  await rig.workingSend()
  await run()
  expectRevokedBeforeClose()
})

it.each([
  {
    cut: 'refused conditional close',
    run: () => rig.host.close(SESSION, 'user-close', () => false)
  },
  { cut: 'refused sleep', run: () => rig.host.sleepWorkspace(workspaceOf(), true, () => false) },
  { cut: 'ordinary Stop', run: () => rig.stop() }
])('$cut keeps the child and its permission writes', async ({ run }) => {
  await workingRig()
  await rig.workingSend()
  await run().catch(() => {})
  // Never cut (a no-op hand-back after the refusal is fine).
  expect(revoked.mock.calls.filter((call) => call[3] === true)).toEqual([])
  expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child).toBeDefined()
})

it('a Stop that ends a starting child revokes it at its receipt, before the close', async () => {
  await workingRig({ starting: true })
  void rig.send('start').result
  await eventually(() =>
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')
  )
  expect(await rig.stop()).toMatchObject({ ok: true })
  expectRevokedBeforeClose()
})

it('a close that fails before its child begins closing gives the child its writes back', async () => {
  await workingRig()
  await rig.workingSend()
  const { deps, sessions } = rig.host.collaboratorsForTests()
  const closing = rig.host.close(SESSION, 'user-close')
  // Admitted and cut already; the close then fails in its lane, before the stop begins.
  const store = vi.spyOn(deps.store, 'selectWritableRecord').mockImplementation(() => {
    throw new Error('store unavailable')
  })
  await expect(closing).rejects.toThrow('store unavailable')
  store.mockRestore()

  expect(sessions.get(SESSION)?.child?.close).toBeUndefined()
  expect(revoked.mock.calls.map((call) => call[3])).toEqual([true, false])
})
