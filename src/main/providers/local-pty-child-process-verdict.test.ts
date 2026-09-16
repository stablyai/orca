import * as pty from 'node-pty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveForegroundMock } = vi.hoisted(() => ({ resolveForegroundMock: vi.fn() }))

vi.mock('./agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: resolveForegroundMock,
  confirmShellForegroundProcess: vi.fn()
}))
import { isRetiredPtyMaster } from '../pty/node-pty-master-fd-retirement'
import {
  hasLocalPtyChildProcesses,
  inspectLocalPtyChildProcesses
} from './local-pty-foreground-inspection'
import { LocalPtyProvider } from './local-pty-provider'
import { ptyProcesses, ptyShellName } from './local-pty-provider-state'
import { inspectPtyProviderProcess } from './pty-process-inspection'

const POSIX_SHELL = '/bin/sh'

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
  if (shell) {
    ptyShellName.set(id, shell)
  }
}

/**
 * A real node-pty whose master has been given up. The getter does not throw here -- it answers
 * `POSIX_SHELL`, which is exactly the recorded shell name, so only the descriptor distinguishes
 * this pane from an idle one.
 */
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
  ptyShellName.set(id, POSIX_SHELL)
  return term
}

beforeEach(() => {
  resolveForegroundMock.mockReset()
  resolveForegroundMock.mockResolvedValue({ available: true, processName: '/bin/zsh' })
})

afterEach(() => {
  ptyProcesses.clear()
  ptyShellName.clear()
})

// Windows has no master fd to retire, and `WindowsTerminal.process` answers from the spawn name.
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe

describe('inspectLocalPtyChildProcesses', () => {
  it('reports unverifiable when the pty fd cannot be read', () => {
    registerPane(
      'pty-closed',
      () => {
        throw new Error('EBADF: bad file descriptor')
      },
      '/bin/zsh'
    )
    expect(inspectLocalPtyChildProcesses('pty-closed')).toBe('unverifiable')
  })

  it('still answers no-children when the shell itself is in the foreground', () => {
    registerPane('pty-idle', '/bin/zsh', '/bin/zsh')
    expect(inspectLocalPtyChildProcesses('pty-idle')).toBe('no-children')
  })

  it('answers children when something else is in the foreground', () => {
    registerPane('pty-busy', 'vim', '/bin/zsh')
    expect(inspectLocalPtyChildProcesses('pty-busy')).toBe('children')
  })

  it('treats a pane this provider does not hold as a real negative', () => {
    expect(inspectLocalPtyChildProcesses('pty-absent')).toBe('no-children')
  })

  it('collapses uncertainty to false only in the boolean adapter', async () => {
    let reads = 0
    registerPane(
      'pty-closed',
      () => {
        reads += 1
        throw new Error('EBADF: bad file descriptor')
      },
      '/bin/zsh'
    )
    await expect(hasLocalPtyChildProcesses('pty-closed')).resolves.toBe(false)
    // The `false` has to come from the failed read, not from an earlier short-circuit.
    expect(reads).toBe(1)
  })
})

describeOnPosix('inspectLocalPtyChildProcesses on a retired master', () => {
  it('reports unverifiable rather than reading the spawn file as an idle shell', async () => {
    const term = await registerRetiredPane('pty-retired')

    // The mechanism is silent: this is the same string an idle pane reports.
    expect(term.process).toBe(POSIX_SHELL)
    // Not `no-children`: the close guard reads that as "nothing is running here" and kills the pane.
    expect(inspectLocalPtyChildProcesses('pty-retired')).toBe('unverifiable')
  }, 15000)

  it('collapses uncertainty to false only in the boolean adapter', async () => {
    await registerRetiredPane('pty-retired')

    // The adapter exists for `IPtyProvider.hasChildProcesses`, which has no third slot.
    await expect(hasLocalPtyChildProcesses('pty-retired')).resolves.toBe(false)
  }, 15000)
})

describe('inspectPtyProviderProcess child-process evidence', () => {
  const provider = new LocalPtyProvider()

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
      hasChildProcesses: false,
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

  it('carries no-children evidence from the local inspectProcess operation', async () => {
    registerPane('pty-idle', '/bin/zsh', '/bin/zsh')

    const inspection = await inspectPtyProviderProcess(provider, 'pty-idle')
    expect(inspection.hasChildProcesses).toBe(false)
    expect(inspection.childProcessEvidence).toBe('no-children')
  })

  it('carries children evidence from the local inspectProcess operation', async () => {
    registerPane('pty-busy', 'vim', '/bin/zsh')

    const inspection = await inspectPtyProviderProcess(provider, 'pty-busy')
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
      hasChildProcesses: false,
      childProcessEvidence: 'unverifiable'
    })
  })
})

describeOnPosix('inspectPtyProviderProcess on a retired master', () => {
  const provider = new LocalPtyProvider()

  it('carries unverifiable child evidence beside the foreground it could still read', async () => {
    await registerRetiredPane('pty-retired')

    const inspection = await inspectPtyProviderProcess(provider, 'pty-retired')
    expect(inspection.hasChildProcesses).toBe(false)
    expect(inspection.childProcessEvidence).toBe('unverifiable')
  }, 15000)
})
