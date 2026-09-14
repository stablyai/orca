import type * as pty from 'node-pty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveForegroundMock } = vi.hoisted(() => ({ resolveForegroundMock: vi.fn() }))

vi.mock('./agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: resolveForegroundMock,
  confirmShellForegroundProcess: vi.fn()
}))
import {
  hasLocalPtyChildProcesses,
  inspectLocalPtyChildProcesses
} from './local-pty-foreground-inspection'
import { LocalPtyProvider } from './local-pty-provider'
import { ptyProcesses, ptyShellName } from './local-pty-provider-state'
import { inspectPtyProviderProcess } from './pty-process-inspection'

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

beforeEach(() => {
  resolveForegroundMock.mockReset()
  resolveForegroundMock.mockResolvedValue({ available: true, processName: '/bin/zsh' })
})

afterEach(() => {
  ptyProcesses.clear()
  ptyShellName.clear()
})

describe('inspectLocalPtyChildProcesses', () => {
  it('reports unverifiable when the pty fd cannot be read', () => {
    registerPane(
      'pty-closed',
      () => {
        throw new Error('EBADF: bad file descriptor')
      },
      '/bin/zsh'
    )

    // Not `no-children`: the close guard reads that as "nothing is running here" and kills the pane.
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
    registerPane(
      'pty-closed',
      () => {
        throw new Error('EBADF: bad file descriptor')
      },
      '/bin/zsh'
    )

    // The adapter exists for `IPtyProvider.hasChildProcesses`, which has no third slot.
    await expect(hasLocalPtyChildProcesses('pty-closed')).resolves.toBe(false)
  })
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
})
