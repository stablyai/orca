import './mock-descendant-sweep'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
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

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import { beginPtyHandlerTest, endPtyHandlerTest, testPtyId } from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

const PANE = 'tab-a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
describe('execution-host launch token authority', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })
  afterEach(async () => endPtyHandlerTest(handler, originalPlatform))
  const spawn = (env: Record<string, string> = {}, extra = {}) =>
    dispatcher.callRequest('pty.spawn', {
      cols: 80,
      rows: 24,
      cwd: tmpdir(),
      env: { ORCA_PANE_KEY: PANE, ORCA_WORKTREE_ID: 'folder:workspace', ...env },
      ...extra
    })

  it.each(['linux', 'darwin', 'win32'])(
    'retains the final successfully spawned environment on %s',
    async (platform) => {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      handler.addEnvAugmenter(() => ({ ORCA_AGENT_LAUNCH_TOKEN: 'augmented-live' }))
      await spawn({ ORCA_AGENT_LAUNCH_TOKEN: 'renderer-before-augmentation' })
      expect(mockPtySpawn.mock.calls[0][2].env.ORCA_AGENT_LAUNCH_TOKEN).toBe('augmented-live')
      expect(handler.getAgentLaunchToken(PANE)).toBe('augmented-live')
    }
  )

  it('keeps deleted and inherited launch identities unverifiable', async () => {
    vi.stubEnv('ORCA_AGENT_LAUNCH_TOKEN', 'inherited-stale')
    await spawn()
    expect(handler.getAgentLaunchToken(PANE)).toBeUndefined()
    await spawn(
      {
        ORCA_PANE_KEY: 'tab-b:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        ORCA_AGENT_LAUNCH_TOKEN: 'deleted'
      },
      { envToDelete: ['ORCA_AGENT_LAUNCH_TOKEN'] }
    )
    expect(
      handler.getAgentLaunchToken('tab-b:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    ).toBeUndefined()
    vi.unstubAllEnvs()
  })

  it('never chooses an arbitrary root when two current PTYs share a pane', async () => {
    await spawn({ ORCA_AGENT_LAUNCH_TOKEN: 'first' })
    await spawn({ ORCA_AGENT_LAUNCH_TOKEN: 'second' })
    expect(handler.getAgentLaunchToken(PANE)).toBeUndefined()
    expect(handler.getTmuxManagedPty(PANE)).toBeNull()
  })

  it('retains no authority from a failed physical spawn', async () => {
    mockPtySpawn.mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })
    await expect(spawn({ ORCA_AGENT_LAUNCH_TOKEN: 'never-started' })).rejects.toThrow(
      'spawn failed'
    )
    expect(handler.getAgentLaunchToken(PANE)).toBeUndefined()
  })

  it('retirement hides authority and accepted attach restores only the existing token', async () => {
    await spawn({ ORCA_AGENT_LAUNCH_TOKEN: 'actual-live' })
    await dispatcher.callRequest('pty.shutdown', { id: testPtyId(1) })
    expect(handler.isPaneSurfaceRetired(PANE)).toBe(true)
    expect(handler.getAgentLaunchToken(PANE)).toBeUndefined()
    await dispatcher.callRequest('pty.attach', { id: testPtyId(1), paneKey: PANE })
    expect(handler.getAgentLaunchToken(PANE)).toBe('actual-live')
  })

  it('does not trust serialized launch tokens during revive', async () => {
    const state = JSON.stringify([
      {
        id: 'pty-legacy',
        pid: process.pid,
        cols: 80,
        rows: 24,
        cwd: tmpdir(),
        paneKey: PANE,
        worktreeId: 'folder:workspace',
        agentLaunchToken: 'untrusted-serialized'
      }
    ])
    await dispatcher.callRequest('pty.revive', { state })
    expect(mockPtySpawn).toHaveBeenCalledOnce()
    expect(mockPtySpawn.mock.calls[0][2].env.ORCA_AGENT_LAUNCH_TOKEN).toBeUndefined()
    expect(handler.getAgentLaunchToken(PANE)).toBeUndefined()
  })
})
