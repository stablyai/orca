import type * as pty from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hasLocalPtyChildProcesses,
  inspectLocalPtyChildProcesses
} from './local-pty-foreground-inspection'
import { LocalPtyProvider } from './local-pty-provider'
import { ptyProcesses, ptyShellName } from './local-pty-provider-state'
import { inspectPtyProviderProcess } from './pty-process-inspection'

/** node-pty's `process` is a native getter over the pty fd; a closed fd makes it throw. */
function registerPane(id: string, foreground: string | (() => never), shell?: string): void {
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
    return expect(inspectLocalPtyChildProcesses('pty-closed')).resolves.toBe('unverifiable')
  })

  it('still answers no-children when the shell itself is in the foreground', async () => {
    registerPane('pty-idle', '/bin/zsh', '/bin/zsh')
    await expect(inspectLocalPtyChildProcesses('pty-idle')).resolves.toBe('no-children')
  })

  it('answers children when something else is in the foreground', async () => {
    registerPane('pty-busy', 'vim', '/bin/zsh')
    await expect(inspectLocalPtyChildProcesses('pty-busy')).resolves.toBe('children')
  })

  it('treats a pane this provider does not hold as a real negative', async () => {
    await expect(inspectLocalPtyChildProcesses('pty-absent')).resolves.toBe('no-children')
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

  it('carries unverifiable evidence from the local inspectProcess operation', async () => {
    registerPane(
      'pty-closed',
      () => {
        throw new Error('EBADF: bad file descriptor')
      },
      '/bin/zsh'
    )

    await expect(inspectPtyProviderProcess(provider, 'pty-closed')).resolves.toEqual({
      foregroundProcess: null,
      hasChildProcesses: false,
      childProcessEvidence: 'unverifiable'
    })
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
