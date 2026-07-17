import { createRequire } from 'node:module'

import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { runSshRelayRuntimePtySmoke } = require('./ssh-relay-runtime-pty-smoke.cjs')

function successfulTerminalFixture({ windows }) {
  const dataListeners = []
  const exitListeners = []
  const subscriptions = []
  const terminal = {
    kill: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
    onData: vi.fn((listener) => {
      dataListeners.push(listener)
      const subscription = { dispose: vi.fn() }
      subscriptions.push(subscription)
      return subscription
    }),
    onExit: vi.fn((listener) => {
      exitListeners.push(listener)
      const subscription = { dispose: vi.fn() }
      subscriptions.push(subscription)
      return subscription
    })
  }
  const nodePty = {
    spawn: vi.fn(() => {
      queueMicrotask(() => {
        const output = windows
          ? 'ORCA_PTY_READY\r\nORCA_PTY_SIZE:101x37\r\nORCA_PTY_INPUT:bounded-marker\r\n'
          : 'ORCA_PTY_READY\n37 101\nORCA_PTY_INPUT:bounded-marker\n'
        dataListeners.forEach((listener) => listener(output))
        exitListeners.forEach((listener) => listener({ exitCode: 23, signal: 0 }))
      })
      return terminal
    })
  }
  return { nodePty, subscriptions, terminal }
}

function runtimeRequire() {
  return {
    loadNativeModule: () => ({ dir: '../build/Release/' })
  }
}

describe('SSH relay runtime PTY smoke lifecycle', () => {
  it('releases successful Windows ConPTY resources after validating the exit', async () => {
    const fixture = successfulTerminalFixture({ windows: true })

    await expect(
      runSshRelayRuntimePtySmoke({
        nodePty: fixture.nodePty,
        runtimeRequire,
        runtimeRoot: 'C:\\runtime',
        platform: 'win32',
        environment: {},
        timeoutMs: 100
      })
    ).resolves.toMatchObject({ exitCode: 23, resizedColumns: 101, resizedRows: 37 })

    expect(fixture.terminal.kill).toHaveBeenCalledOnce()
    expect(fixture.subscriptions).toHaveLength(3)
    fixture.subscriptions.forEach((subscription) => {
      expect(subscription.dispose).toHaveBeenCalledOnce()
    })
  })

  it('disposes successful POSIX listeners without killing an exited terminal', async () => {
    const fixture = successfulTerminalFixture({ windows: false })

    await expect(
      runSshRelayRuntimePtySmoke({
        nodePty: fixture.nodePty,
        runtimeRequire,
        runtimeRoot: '/runtime',
        platform: 'linux',
        environment: { SHELL: '/bin/sh' },
        timeoutMs: 100
      })
    ).resolves.toMatchObject({ exitCode: 23, resizedColumns: 101, resizedRows: 37 })

    expect(fixture.terminal.kill).not.toHaveBeenCalled()
    fixture.subscriptions.forEach((subscription) => {
      expect(subscription.dispose).toHaveBeenCalledOnce()
    })
  })
})
