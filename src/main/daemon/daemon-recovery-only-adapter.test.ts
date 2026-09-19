import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'
import { STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION } from './daemon-protocol-version'
import { DaemonPtyRouter } from './daemon-pty-router'

let harness: DaemonAdapterHarness
let recovery: DaemonPtyAdapter
let subprocess: ReturnType<typeof createMockSubprocess>
const spawn = vi.fn(() => subprocess)
const respawn = vi.fn(async () => {})

beforeEach(async () => {
  spawn.mockClear()
  respawn.mockClear()
  subprocess = createMockSubprocess()
  harness = await startDaemonAdapterHarness(spawn)
  await harness.adapter.spawn({ sessionId: 'existing', cols: 80, rows: 24 })
  recovery = new DaemonPtyAdapter({
    socketPath: harness.socketPath,
    tokenPath: harness.tokenPath,
    recoveryOnly: true,
    respawn
  })
})

afterEach(async () => {
  recovery?.dispose()
  harness.adapter.dispose()
  await harness.server.shutdown()
  rmSync(harness.dir, { recursive: true, force: true })
})

it('reattaches and controls existing work without admitting a new process', async () => {
  await expect(
    recovery.spawn({ sessionId: 'existing', attachOnly: true, cols: 80, rows: 24 })
  ).resolves.toMatchObject({ id: 'existing', isReattach: true })
  recovery.write('existing', 'still live\n')
  await waitFor(() => subprocess.write.mock.calls.length > 0)
  expect(subprocess.write).toHaveBeenCalledWith('still live\n')
  await expect(recovery.spawn({ sessionId: 'fresh', cols: 80, rows: 24 })).rejects.toThrow(
    'managed-stop recovery'
  )
  await expect(
    recovery.spawn({ sessionId: 'missing', attachOnly: true, cols: 80, rows: 24 })
  ).rejects.toThrow()
  expect(spawn).toHaveBeenCalledOnce()
  expect(respawn).not.toHaveBeenCalled()
})

it('does not certify fresh admission after a confirmed native stop refusal', async () => {
  await expect(recovery.requestIdleRetirement()).resolves.toEqual({
    state: 'busy',
    liveSessions: 1
  })
  await expect(
    recovery.spawn({ sessionId: 'existing', attachOnly: true, cols: 80, rows: 24 })
  ).resolves.toMatchObject({ isReattach: true })
  await expect(recovery.spawn({ cols: 80, rows: 24 })).rejects.toThrow('managed-stop recovery')
  expect(spawn).toHaveBeenCalledOnce()
})

it('does not invoke a supplied replacement launcher after endpoint loss', async () => {
  await recovery.listProcesses()
  await harness.server.shutdown()
  await expect(
    recovery.spawn({ sessionId: 'existing', attachOnly: true, cols: 80, rows: 24 })
  ).rejects.toThrow()
  expect(respawn).not.toHaveBeenCalled()
})

it('keeps recovery-only admission through routed inventory refusal', async () => {
  const router = new DaemonPtyRouter({ current: recovery, legacy: [] })
  await expect(router.requestIdleRetirement()).resolves.toEqual({ state: 'busy', liveSessions: 1 })
  await expect(
    router.spawn({ sessionId: 'existing', attachOnly: true, cols: 80, rows: 24 })
  ).resolves.toMatchObject({ isReattach: true })
  await expect(router.spawn({ cols: 80, rows: 24 })).rejects.toThrow('managed-stop recovery')
  expect(spawn).toHaveBeenCalledOnce()
})

it('rejects legacy attach emulation before contacting the daemon', async () => {
  const legacy = new DaemonPtyAdapter({
    socketPath: harness.socketPath,
    tokenPath: harness.tokenPath,
    protocolVersion: STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION - 1,
    recoveryOnly: true
  })
  try {
    await expect(
      legacy.spawn({ sessionId: 'existing', attachOnly: true, cols: 80, rows: 24 })
    ).rejects.toThrow('managed-stop recovery')
    expect(spawn).toHaveBeenCalledOnce()
  } finally {
    legacy.dispose()
  }
})
