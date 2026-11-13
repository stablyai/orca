import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createLinuxLauncherBadge, type LauncherBadgeHelperProcess } from './linux-launcher-badge'

function fakeChild(): LauncherBadgeHelperProcess &
  EventEmitter & { stderr: PassThrough; stdinText: () => string } {
  const stdin = new PassThrough()
  let written = ''
  stdin.on('data', (chunk: Buffer) => {
    written += chunk.toString()
  })
  const exitCode: number | null = null
  const signalCode: NodeJS.Signals | null = null
  return Object.assign(new EventEmitter(), {
    stdin,
    stderr: new PassThrough(),
    exitCode,
    signalCode,
    kill: vi.fn(() => true),
    stdinText: () => written
  })
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

describe('createLinuxLauncherBadge', () => {
  it('starts the helper on the first non-zero count, streams counts as lines and ends stdin on dispose', async () => {
    const child = fakeChild()
    const spawn = vi.fn(() => child)
    const badge = createLinuxLauncherBadge({
      desktopFileName: 'orca-ide.desktop',
      resolveHelperPath: async () => '/resources/linux-launcher-badge/launcher-badge.py',
      spawn,
      warn: vi.fn()
    })

    badge.setCount(0)
    expect(spawn).not.toHaveBeenCalled()

    badge.setCount(3)
    badge.setCount(5)
    await settle()
    expect(spawn).toHaveBeenCalledWith({
      program: 'python3',
      args: ['/resources/linux-launcher-badge/launcher-badge.py', 'orca-ide.desktop']
    })
    badge.setCount(5)
    badge.setCount(0)
    await settle()
    expect(child.stdinText()).toBe('5\n0\n')

    badge.dispose()
    await settle()
    expect(child.stdin.writableEnded).toBe(true)
  })

  it('warns once and never respawns after the helper reports an unsupported host', async () => {
    const child = fakeChild()
    const spawn = vi.fn(() => child)
    const warn = vi.fn()
    const badge = createLinuxLauncherBadge({
      desktopFileName: 'orca-ide.desktop',
      resolveHelperPath: async () => '/resources/linux-launcher-badge/launcher-badge.py',
      spawn,
      warn
    })

    badge.setCount(2)
    await settle()
    child.stderr.write('launcher-badge: GObject introspection unavailable: No module named gi\n')
    child.emit('exit', 2, null)
    badge.setCount(4)
    badge.setCount(0)
    badge.setCount(6)
    await settle()

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('No module named gi')
  })
})
