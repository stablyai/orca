import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

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

import * as ptyShellUtils from './pty-shell-utils'
import type { PtyHandler } from './pty-handler'
import {
  IMMEDIATE_PTY_EXIT_TIMEOUT_MS,
  SHUTDOWN_REAP_MAX_SWEEPS,
  SHUTDOWN_REAP_VERIFY_DELAY_MS
} from './pty-handler'
import {
  beginPtyHandlerTest,
  createPtyRequestHelpers,
  endPtyHandlerTest
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

const PANE_KEY = 'tab-agent:22222222-2222-4222-8222-222222222222'

const AGENT_SESSION_ENSURE = {
  claim: {
    digestVersion: 1,
    keyId: 'claim-key',
    identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    agent: 'claude'
  },
  surface: {
    worktreeId: 'repo::/tmp/worktree',
    tabId: '11111111-1111-4111-8111-111111111111',
    leafId: '22222222-2222-4222-8222-222222222222',
    terminalHandle: 'term_claimed'
  }
}

type ProcessSummary = {
  id: string
  agentSessionOwners?: unknown[]
}

describe('PtyHandler retires a closed pane surface', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  const { spawnPty } = createPtyRequestHelpers(() => dispatcher)

  async function spawnAgentPane(
    params: Record<string, unknown> = {}
  ): Promise<{ id: string; term: typeof mockPtyInstance }> {
    const term = { ...mockPtyInstance, kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() }
    mockPtySpawn.mockReturnValue(term)
    const spawned = await spawnPty({
      env: { ORCA_PANE_KEY: PANE_KEY },
      agentSessionEnsure: AGENT_SESSION_ENSURE,
      ...params
    })
    return { id: spawned.id, term }
  }

  async function listProcesses(): Promise<ProcessSummary[]> {
    return (await dispatcher.callRequest('pty.listProcesses', {})) as ProcessSummary[]
  }

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('marks the pane surface retired as soon as its tab is closed', async () => {
    const retired: { id: string; paneKey: string }[] = []
    handler.setSurfaceRetiredListener((event) => retired.push(event))
    const { id } = await spawnAgentPane()

    expect(handler.isPaneSurfaceRetired(PANE_KEY)).toBe(false)

    await dispatcher.callRequest('pty.shutdown', { id })

    expect(handler.isPaneSurfaceRetired(PANE_KEY)).toBe(true)
    expect(retired).toEqual([{ id, paneKey: PANE_KEY }])
  })

  it('retires the surface even when the shell survives the kill request', async () => {
    vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(true)
    const { id } = await spawnAgentPane()

    await dispatcher.callRequest('pty.shutdown', { id })
    await vi.advanceTimersByTimeAsync(
      SHUTDOWN_REAP_VERIFY_DELAY_MS * (SHUTDOWN_REAP_MAX_SWEEPS + 2)
    )

    // The process could not be verified gone, so the claim is deliberately kept — releasing it is
    // what would let a reopened project fork a second agent onto the same transcript.
    expect(handler.isPaneSurfaceRetired(PANE_KEY)).toBe(true)
    const sessions = await listProcesses()
    expect(sessions.map((session) => session.id)).toEqual([id])
  })

  it('re-issues the force kill instead of letting a detached shell outlive its tab', async () => {
    vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(true)
    const { id, term } = await spawnAgentPane()

    await dispatcher.callRequest('pty.shutdown', { id })
    // The graceful path's own armed fallback fires first; count only what the sweep adds.
    await vi.advanceTimersByTimeAsync(SHUTDOWN_REAP_VERIFY_DELAY_MS - 1)
    const killsBeforeSweep = term.kill.mock.calls.filter(([signal]) => signal === 'SIGKILL').length

    await vi.advanceTimersByTimeAsync(
      SHUTDOWN_REAP_VERIFY_DELAY_MS * (SHUTDOWN_REAP_MAX_SWEEPS + 2)
    )

    const killsAfterSweep = term.kill.mock.calls.filter(([signal]) => signal === 'SIGKILL').length
    expect(killsAfterSweep - killsBeforeSweep).toBe(SHUTDOWN_REAP_MAX_SWEEPS)
  })

  it('never re-closes a ConPTY handle on Windows, where the first kill is already final', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(true)
    const { id, term } = await spawnAgentPane()

    // The immediate path is the one that reaches ConPTY's kill without setting gracefulKillSent.
    const shutdown = dispatcher.callRequest('pty.shutdown', { id, immediate: true })
    const rejected = expect(shutdown).rejects.toThrow('Timed out waiting for PTY process exit')
    await vi.advanceTimersByTimeAsync(IMMEDIATE_PTY_EXIT_TIMEOUT_MS)
    await rejected
    await vi.advanceTimersByTimeAsync(
      SHUTDOWN_REAP_VERIFY_DELAY_MS * (SHUTDOWN_REAP_MAX_SWEEPS + 2)
    )

    expect(term.kill.mock.calls).toHaveLength(1)
  })

  it('retires the relay session once the sweep proves the process is gone', async () => {
    const exits: { id: string; paneKey?: string }[] = []
    handler.setExitListener((event) => exits.push(event))
    const alive = vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(true)
    const { id } = await spawnAgentPane()

    expect((await listProcesses())[0]?.agentSessionOwners).toHaveLength(1)

    await dispatcher.callRequest('pty.shutdown', { id })
    alive.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(SHUTDOWN_REAP_VERIFY_DELAY_MS + 1)

    // The sweep itself must retire it — node-pty produced no exit, and nothing here polls a listing.
    expect(exits).toEqual([{ id, paneKey: PANE_KEY }])
    expect(await listProcesses()).toEqual([])
  })

  it('stops advertising an agent session whose process died without a node-pty exit', async () => {
    const alive = vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(true)
    await spawnAgentPane()

    expect((await listProcesses())[0]?.agentSessionOwners).toHaveLength(1)

    // No shutdown, no onExit — the shell just went away. The relay has to look.
    alive.mockReturnValue(false)

    expect(await listProcesses()).toEqual([])
  })

  it('restores the surface when a new PTY binds the same pane key', async () => {
    const { id } = await spawnAgentPane()
    await dispatcher.callRequest('pty.shutdown', { id })
    expect(handler.isPaneSurfaceRetired(PANE_KEY)).toBe(true)

    const term = { ...mockPtyInstance, kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() }
    mockPtySpawn.mockReturnValue(term)
    await spawnPty({ env: { ORCA_PANE_KEY: PANE_KEY } })

    expect(handler.isPaneSurfaceRetired(PANE_KEY)).toBe(false)
  })

  it('restores the surface when a client reattaches to a shut-down PTY that survived', async () => {
    vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(true)
    const { id } = await spawnAgentPane()
    await dispatcher.callRequest('pty.shutdown', { id })
    expect(handler.isPaneSurfaceRetired(PANE_KEY)).toBe(true)

    await dispatcher.callRequest('pty.attach', { id })

    expect(handler.isPaneSurfaceRetired(PANE_KEY)).toBe(false)
  })

  it('shutting down a pane with no pane key retires nothing', async () => {
    const retired: { id: string; paneKey: string }[] = []
    handler.setSurfaceRetiredListener((event) => retired.push(event))
    const term = { ...mockPtyInstance, kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() }
    mockPtySpawn.mockReturnValue(term)
    const spawned = await spawnPty({})

    await dispatcher.callRequest('pty.shutdown', { id: spawned.id })

    expect(retired).toEqual([])
  })
})
