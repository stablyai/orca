// Regression guard for the Windows SSH child-process answer. The relay used to return a hardcoded
// `false` here, which every close guard reads as "nothing is running in this pane" -- so a Windows
// SSH pane running a build closed with no prompt. The answer now comes from the process table, and
// the one thing it may never do again is fabricate a negative.
//
// The second contract is cost. `pty.inspectProcess` is the polled path (750ms/2000ms per tracked
// pane) and a relay host has no `@vscode/windows-process-tree`, so its table read falls back to a
// 1.36s CIM scan. Polling that would reinstate the fork storm the shared table exists to prevent,
// so only a caller whose answer decides something asks for the scan.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    process: 'xterm-256color',
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

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import * as ptyChildProcessInspection from './pty-child-process-inspection'
import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  createPtyRequestHelpers,
  endPtyHandlerTest
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

type Inspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  childProcessEvidence?: string
}

describe('PtyHandler Windows child-process evidence', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined
  let inspectChildren: ReturnType<typeof vi.spyOn>

  const { spawnPty } = createPtyRequestHelpers(() => dispatcher)

  /** Spawn under the harness's POSIX platform, then answer as the Windows relay would. */
  async function spawnThenBecomeWindows(): Promise<string> {
    const { id } = await spawnPty()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    return id
  }

  async function inspect(params: Record<string, unknown>): Promise<Inspection> {
    return (await dispatcher.callRequest('pty.inspectProcess', params)) as Inspection
  }

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    inspectChildren = vi
      .spyOn(ptyChildProcessInspection, 'inspectPtyChildProcesses')
      .mockResolvedValue('no-children')
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('publishes what the host observed when the caller pays for the scan', async () => {
    const id = await spawnThenBecomeWindows()
    inspectChildren.mockResolvedValue('children')

    const result = await inspect({ id, scanChildProcesses: true })

    expect(inspectChildren).toHaveBeenCalledWith(mockPtyInstance.pid)
    expect(result.childProcessEvidence).toBe('children')
    expect(result.hasChildProcesses).toBe(true)
  })

  it('reports an observed-empty pane as no-children, not merely false', async () => {
    const id = await spawnThenBecomeWindows()
    inspectChildren.mockResolvedValue('no-children')

    const result = await inspect({ id, scanChildProcesses: true })

    // Asserted alongside the value so the case fails if the answer stops coming from a real read.
    expect(inspectChildren).toHaveBeenCalledWith(mockPtyInstance.pid)
    expect(result.childProcessEvidence).toBe('no-children')
    expect(result.hasChildProcesses).toBe(false)
  })

  it('keeps the compatibility boolean false when the host could not observe the pane', async () => {
    const id = await spawnThenBecomeWindows()
    inspectChildren.mockResolvedValue('unverifiable')

    const result = await inspect({ id, scanChildProcesses: true })

    expect(result.childProcessEvidence).toBe('unverifiable')
    // Clients too old to read the verdict also read `true` as "an agent took the PTY, safe to
    // type into it", so `unverifiable` must not be promoted to `true` on the shared boolean.
    expect(result.hasChildProcesses).toBe(false)
  })

  it('never reads the process table for a poll, and says so instead of guessing', async () => {
    const id = await spawnThenBecomeWindows()

    const result = await inspect({ id })

    expect(inspectChildren).not.toHaveBeenCalled()
    expect(result.childProcessEvidence).toBe('unverifiable')
    expect(result.hasChildProcesses).toBe(false)
  })
})
