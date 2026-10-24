import { expect, it, vi } from 'vitest'
import { registerBoundPty } from './bind-first-pane.test-fixture'
import { TerminalInterfaceAuthority } from '../agent-hooks/server/terminal-interface-authority'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
const { HEADLESS_LEAF_ID, TEST_WORKTREE_ID, TEST_WORKTREE_PATH } =
  await import('./orca-runtime-test-fixtures.spec')
const { SURFACE_TAB_ID, surfaceRuntime } =
  await import('./terminal/surface/terminal-surface-replies.test-fixture')

it('observes main-bound terminals without pane copies and retracts after exit', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  const authority = new TerminalInterfaceAuthority()
  const harness = surfaceRuntime()
  const runtime = new OrcaRuntimeService(harness.runtime['store'], undefined, {
    terminalInterfaces: authority
  })
  const inspect = vi.fn(async () => ({
    foregroundProcess: 'bash',
    hasChildProcesses: false,
    terminalInterface: {
      shellForeground: true,
      children: 'no-children' as const,
      capturedAgeMs: 0
    }
  }))
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [
      { id: 'pty-observed', cwd: TEST_WORKTREE_PATH, title: 'bash', incarnationId: 'birth' }
    ],
    inspectProcess: inspect
  })
  const tabId = SURFACE_TAB_ID
  const leafId = HEADLESS_LEAF_ID
  const paneKey = `${tabId}:${leafId}`
  try {
    registerBoundPty(runtime, 'pty-observed', TEST_WORKTREE_ID, null, {
      tabId,
      leafId,
      incarnationId: 'birth'
    })
    const pty = runtime['ptysById'].get('pty-observed')!
    expect(pty.paneKey).toBeUndefined()
    await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(pty.connected).toBe(true)
    expect(runtime['paneOfPty'](pty).paneKey).toBe(paneKey)
    expect(runtime['handleByPtyId'].has('pty-observed')).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(inspect).toHaveBeenCalledWith('pty-observed', {
      expectedIncarnationId: 'birth',
      scanChildProcesses: true,
      terminalInterface: true,
      steadyState: false
    })
    expect(authority.read('pty-observed', 'birth')).toMatchObject({ paneKey, state: 'shell' })
    expect(authority.read('pty-observed', 'another-birth')).toBeNull()
    runtime.onPtyExit('pty-observed', 0, 'birth')
    expect(authority.snapshot()).toEqual([])
  } finally {
    authority.stop()
    vi.useRealTimers()
  }
})
