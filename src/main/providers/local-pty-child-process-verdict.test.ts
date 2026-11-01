import * as pty from 'node-pty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveForegroundMock } = vi.hoisted(() => ({ resolveForegroundMock: vi.fn() }))
const jobMembers = vi.hoisted(() => vi.fn())
vi.mock('./windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: jobMembers,
  isWindowsPtyJobReadable: () => true
}))

const { confirmShellForegroundMock } = vi.hoisted(() => ({
  confirmShellForegroundMock: vi.fn()
}))

vi.mock('./agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: resolveForegroundMock,
  confirmShellForegroundProcess: confirmShellForegroundMock
}))
import { isRetiredPtyMaster } from '../pty/node-pty-master-fd-retirement'

import { LocalPtyProvider } from './local-pty-provider'
import { ptyIncarnations, ptyProcesses, ptyShellPath } from './local-pty-provider-state'
import { inspectPtyProviderProcess } from './pty-process-inspection'

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

  it('uses the owned Windows job without a static-name marker, preserving uncertain and replaced panes', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    registerPane('pty-win', 'powershell.exe', 'powershell.exe')
    const inspect = () =>
      inspectPtyProviderProcess(provider, 'pty-win', {
        expectedIncarnationId: 'incarnation:pty-win'
      })
    jobMembers.mockReturnValue(new Set([4242]))
    await expect(inspect()).resolves.toMatchObject({
      childProcessEvidence: 'no-children',
      hasChildProcesses: false
    })
    jobMembers.mockReturnValue(new Set([4242, 4243]))
    await expect(inspect()).resolves.toMatchObject({
      childProcessEvidence: 'children',
      hasChildProcesses: true
    })
    jobMembers.mockReturnValue(null)
    await expect(inspect()).resolves.toMatchObject({
      childProcessEvidence: 'unverifiable',
      hasChildProcesses: true
    })
    jobMembers.mockImplementationOnce(() => {
      registerPane('pty-win', 'powershell.exe', 'powershell.exe')
      return new Set([4242])
    })
    await expect(inspect()).resolves.toMatchObject({
      childProcessEvidence: 'unverifiable',
      hasChildProcesses: true
    })
  })

  it('carries unverifiable evidence when the child read fails after foreground inspection', async () => {
    let reads = 0
    registerPane(
      'pty-closing',
      () => {
        reads += 1
        if (reads > 1) {
          throw new Error('EBADF: bad file descriptor')
        }
        return '/bin/zsh'
      },
      '/bin/zsh'
    )
    await expect(inspectPtyProviderProcess(provider, 'pty-closing')).resolves.toEqual({
      foregroundProcess: '/bin/zsh',
      hasChildProcesses: true,
      childProcessEvidence: 'unverifiable'
    })
  })

  it('samples child evidence after foreground inspection', async () => {
    let reads = 0
    registerPane('pty-became-busy', () => (reads++ === 0 ? '/bin/zsh' : 'vim'), '/bin/zsh')

    const inspection = await inspectPtyProviderProcess(provider, 'pty-became-busy')
    expect(inspection.hasChildProcesses).toBe(true)
    expect(inspection.childProcessEvidence).toBe('children')
  })

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
