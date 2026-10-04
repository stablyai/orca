import './mock-descendant-sweep'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe, mockApplyTrust } =
  vi.hoisted(() => ({
    mockPtySpawn: vi.fn(),
    mockCreateShellPromptReadinessProbe: vi.fn(),
    mockApplyTrust: vi.fn(),
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

vi.mock('./agent-workspace-trust-spawn', () => ({
  applyRelayAgentWorkspaceTrust: mockApplyTrust
}))

import type { PtyHandler } from './pty-handler'
import { beginPtyHandlerTest, endPtyHandlerTest } from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

describe('relay pty.spawn agent workspace trust', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let root: string

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    mockApplyTrust.mockReset()
    root = mkdtempSync(join(tmpdir(), 'orca-relay-trust-spawn-'))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
    rmSync(root, { recursive: true, force: true })
  })

  it("writes the launch's trust with its final env before the agent's process starts", async () => {
    let finishTrust = (): void => {}
    mockApplyTrust.mockReturnValue(
      new Promise<void>((resolve) => {
        finishTrust = resolve
      })
    )
    const request = { workspacePath: root }

    const spawned = dispatcher.callRequest('pty.spawn', {
      cols: 80,
      rows: 24,
      cwd: root,
      launchAgent: 'codex',
      env: { CODEX_HOME: '/remote/codex-home' },
      agentWorkspaceTrust: request
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(mockApplyTrust).toHaveBeenCalledWith(
      request,
      'codex',
      expect.objectContaining({ CODEX_HOME: '/remote/codex-home' }),
      { wslShell: false }
    )
    expect(mockPtySpawn).not.toHaveBeenCalled()
    finishTrust()
    await spawned
    expect(mockPtySpawn).toHaveBeenCalledTimes(1)
  })
})
