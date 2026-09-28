import { describe, expect, it, vi } from 'vitest'

const { wrapShellSpawnMock } = vi.hoisted(() => ({
  wrapShellSpawnMock: vi.fn((file: string, args: string[]) => ({ file, args }))
}))

vi.mock('../../providers/macos-tcc-login-shell', () => ({
  hostReportsChildExitStatus: (file: string) => file !== '/usr/bin/login',
  wrapShellSpawnForMacosTccAttribution: wrapShellSpawnMock
}))

import { spawnNativeDaemonPty } from './native-pty-spawn'

describe('native PTY runtime selection', () => {
  it('refuses an unsupported runtime before attempting any shell', async () => {
    const spawnBunPty = vi.fn()
    await expect(
      spawnNativeDaemonPty(
        {
          shellPath: '/bin/sh',
          shellArgs: [],
          spawnCwd: '/tmp',
          env: {},
          cols: 80,
          rows: 24,
          windowsFallbackAttempts: []
        },
        { canUseBunPty: () => false, spawnBunPty }
      )
    ).rejects.toThrow('requires the bundled Bun')
    expect(spawnBunPty).not.toHaveBeenCalled()
  })

  it('spawns with Bun.Terminal without loading node-pty', async () => {
    const dispose = vi.fn()
    const spawnBunPty = vi.fn(() => ({
      pid: 9876,
      cols: 80,
      rows: 24,
      process: '/bin/zsh',
      handleFlowControl: false,
      onData: vi.fn(() => ({ dispose })),
      onExit: vi.fn(() => ({ dispose })),
      write: vi.fn(),
      resize: vi.fn(),
      clear: vi.fn(),
      kill: vi.fn(),
      destroy: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn()
    }))

    const result = await spawnNativeDaemonPty(
      {
        shellPath: '/bin/zsh',
        shellArgs: ['-l'],
        spawnCwd: '/tmp',
        env: { TERM: 'xterm-256color' },
        cols: 80,
        rows: 24,
        windowsFallbackAttempts: []
      },
      { canUseBunPty: () => true, spawnBunPty }
    )

    expect(result.process.pid).toBe(9876)
    expect(spawnBunPty).toHaveBeenCalledOnce()
  })

  it('applies the macOS login wrapper before selecting the Bun PTY runtime', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const spawnBunPty = vi.fn(() => ({
      pid: 9877,
      cols: 80,
      rows: 24,
      process: '/usr/bin/login',
      handleFlowControl: false,
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
      resize: vi.fn(),
      clear: vi.fn(),
      kill: vi.fn(),
      destroy: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn()
    }))
    const onMacosTccSpawnStrategy = vi.fn()
    wrapShellSpawnMock.mockReturnValueOnce({
      file: '/usr/bin/login',
      args: ['-flpq', 'tester', '/bin/zsh', '-l']
    })
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })

    try {
      const result = await spawnNativeDaemonPty(
        {
          shellPath: '/bin/zsh',
          shellArgs: ['-l'],
          spawnCwd: '/tmp',
          env: { TERM: 'xterm-256color' },
          cols: 80,
          rows: 24,
          windowsFallbackAttempts: [],
          onMacosTccSpawnStrategy
        },
        { canUseBunPty: () => true, spawnBunPty }
      )

      expect(result.process.pid).toBe(9877)
      expect(spawnBunPty).toHaveBeenCalledWith(
        expect.objectContaining({
          file: '/usr/bin/login',
          args: ['-flpq', 'tester', '/bin/zsh', '-l']
        })
      )
      expect(result.reportsChildExitStatus).toBe(false)
      expect(onMacosTccSpawnStrategy).toHaveBeenCalledWith('wrapped')
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })
})
