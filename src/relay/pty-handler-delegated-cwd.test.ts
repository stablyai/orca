import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as PtyShell from './pty-shell-utils'
import { beginPtyHandlerTest, endPtyHandlerTest, testPtyId } from './pty-handler-test-harness'

const mocks = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  probeCwd: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))
vi.mock('node-pty', () => ({ spawn: mocks.mockPtySpawn }))
vi.mock('./pty-shell-utils', async (original) => ({
  ...(await original<typeof PtyShell>()),
  probeProcessCwd: mocks.probeCwd
}))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mocks.mockCreateShellPromptReadinessProbe
}))
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

let fixture: ReturnType<typeof beginPtyHandlerTest>
let incarnation: string
const id = testPtyId(1)
beforeEach(async () => {
  fixture = beginPtyHandlerTest(mocks)
  mocks.probeCwd.mockReset().mockResolvedValue('/srv/current')
  await fixture.dispatcher.callRequest('pty.spawn', {})
  incarnation = fixture.handler.resolveOwnershipTransferTerminal(id)!.incarnationId
})
afterEach(async () => {
  await endPtyHandlerTest(fixture.handler, fixture.originalPlatform)
})

it('reads the host pid and preserves unavailable cwd as null', async () => {
  await expect(
    fixture.handler.inspectOwnershipTransferCwd(id, incarnation, () => true)
  ).resolves.toBe('/srv/current')
  expect(mocks.probeCwd).toHaveBeenCalledWith(process.pid)
  mocks.probeCwd.mockResolvedValue(null)
  await expect(
    fixture.handler.inspectOwnershipTransferCwd(id, incarnation, () => true)
  ).resolves.toBeNull()
})

it.each(['unauthorized', 'wrong-incarnation', 'missing'])(
  'refuses %s before probing',
  async (mode) => {
    await expect(
      fixture.handler.inspectOwnershipTransferCwd(
        mode === 'missing' ? 'missing' : id,
        mode === 'wrong-incarnation' ? 'wrong' : incarnation,
        () => mode !== 'unauthorized'
      )
    ).rejects.toThrow('inspection_unverifiable')
    expect(mocks.probeCwd).not.toHaveBeenCalled()
  }
)

it('discards an answer when the claim is superseded during the probe', async () => {
  let authorized = true
  mocks.probeCwd.mockImplementation(async () => {
    authorized = false
    return '/srv/stale'
  })
  await expect(
    fixture.handler.inspectOwnershipTransferCwd(id, incarnation, () => authorized)
  ).rejects.toThrow('inspection_unverifiable')
})

it('discards an answer when the terminal exits during the probe', async () => {
  mocks.probeCwd.mockImplementation(async () => {
    mocks.mockPtyInstance.onExit.mock.calls[0][0]({ exitCode: 0 })
    return '/srv/stale'
  })
  await expect(
    fixture.handler.inspectOwnershipTransferCwd(id, incarnation, () => true)
  ).rejects.toThrow('inspection_unverifiable')
})
