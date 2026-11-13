import * as pty from 'node-pty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PtyMasterForegroundObservation from '../../pty/process-retirement/pty-master-foreground-observation'

const { resolveForegroundMock } = vi.hoisted(() => ({ resolveForegroundMock: vi.fn() }))
const jobMembers = vi.hoisted(() => vi.fn())
vi.mock('../foreground/windows/pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: jobMembers,
  isWindowsPtyJobReadable: () => true
}))

const { confirmShellForegroundMock } = vi.hoisted(() => ({
  confirmShellForegroundMock: vi.fn()
}))

vi.mock('../foreground/agent-process', () => ({
  resolveAgentForegroundProcessWithAvailability: resolveForegroundMock,
  confirmShellForegroundProcess: confirmShellForegroundMock
}))

const observeForegroundMock = vi.hoisted(() => vi.fn())
vi.mock(
  '../../pty/process-retirement/pty-master-foreground-observation',
  async (importOriginal) => ({
    ...(await importOriginal<typeof PtyMasterForegroundObservation>()),
    observePtyForeground: observeForegroundMock
  })
)
import { isRetiredPtyMaster } from '../../pty/process-retirement/node-pty-master-fd-retirement'

import { LocalPtyProvider } from './local-pty-provider'
import { ptyIncarnations, ptyProcesses, ptyShellPath } from './local-pty-provider-state'
import { inspectPtyProviderProcess } from '../pty/process-inspection'

// Match the recorded basename so only the retired descriptor distinguishes the pane from idle.
const POSIX_SHELL = 'sh'

function registerPane(id: string, foreground: string | (() => string), shell?: string): void {
  const pane: pty.IPty = {
    pid: 4242,
    cols: 80,
    rows: 24,
    get process(): string {
      return typeof foreground === 'function' ? foreground() : foreground
    },
    handleFlowControl: false,
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    resize() {},
    clear() {},
    write() {},
    kill() {},
    pause() {},
    resume() {}
  }
  ptyProcesses.set(id, pane)
  ptyIncarnations.set(id, `incarnation:${id}`)
  if (shell) {
    ptyShellPath.set(id, shell)
  }
}

/** Retired node-pty getters still report the spawn name; only descriptor state distinguishes this from idle. */
async function registerRetiredPane(id: string): Promise<pty.IPty> {
  const term = pty.spawn(POSIX_SHELL, ['-c', 'exit 0'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: { ...process.env }
  })
  await new Promise<void>((resolve) => {
    term.onExit(() => resolve())
  })
  // `onExit` runs before node-pty's `_close()`, which is where the patch retires `_fd`.
  await vi.waitFor(() => expect(isRetiredPtyMaster(term)).toBe(true), {
    timeout: 10000,
    interval: 10
  })
  ptyProcesses.set(id, term)
  ptyIncarnations.set(id, `incarnation:${id}`)
  ptyShellPath.set(id, POSIX_SHELL)
  return term
}

beforeEach(() => {
  // These fake foreground names model POSIX; Windows uses the owned-job fixture below.
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  jobMembers.mockReset()
  resolveForegroundMock.mockReset()
  resolveForegroundMock.mockResolvedValue({ available: true, processName: '/bin/zsh' })
})

afterEach(() => {
  vi.restoreAllMocks()
  ptyProcesses.clear()
  ptyIncarnations.clear()
  ptyShellPath.clear()
})

// Windows has no master fd to retire, and `WindowsTerminal.process` answers from the spawn name.
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe

describe('inspectPtyProviderProcess child-process evidence', () => {
  const provider = new LocalPtyProvider()

  it('refuses to pair one panes foreground with its replacements children', async () => {
    registerPane('pty-swapped', '/bin/zsh', '/bin/zsh')
    resolveForegroundMock.mockImplementation(async () => {
      // Cleanup plus reactivation lands a different IPty under the same id mid-read.
      registerPane('pty-swapped', 'vim', '/bin/zsh')
      return { available: true, processName: '/bin/zsh' }
    })

    await expect(inspectPtyProviderProcess(provider, 'pty-swapped')).resolves.toEqual({
      foregroundProcess: null,
      hasChildProcesses: true,
      childProcessEvidence: 'unverifiable'
    })
  })
})

describeOnPosix('inspectPtyProviderProcess on a retired master', () => {
  const provider = new LocalPtyProvider()

  it('carries unverifiable child evidence beside the foreground it could still read', async () => {
    await registerRetiredPane('pty-retired')

    const inspection = await inspectPtyProviderProcess(provider, 'pty-retired')
    expect(inspection.hasChildProcesses).toBe(true)
    expect(inspection.childProcessEvidence).toBe('unverifiable')
  }, 15000)
})
