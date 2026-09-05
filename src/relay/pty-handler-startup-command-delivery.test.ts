import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../shared/setup-agent-sequencing'
import * as ptyShellUtils from './pty-shell-utils'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    // Why: attach now proves the backing pid is alive before replaying, so the
    // default managed PTY must report a live pid. Reuse the test runner's own
    // pid — always alive — so unrelated attach tests are not seen as dead.
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

import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  createPtyRequestHelpers,
  endPtyHandlerTest,
  testPtyId
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

const PTY_1 = testPtyId(1)

describe('PtyHandler', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  const { spawnPty, attachPty } = createPtyRequestHelpers(() => dispatcher)

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('keeps SSH spawn commands as hints unless provider delivery is requested', async () => {
    await dispatcher.callRequest('pty.spawn', { command: 'echo renderer-owned' })

    vi.advanceTimersByTime(50)

    const term = mockPtySpawn.mock.results[0]?.value
    expect(term.write).not.toHaveBeenCalled()
  })

  it('submits provider-delivered spawn commands to the relay shell', async () => {
    await dispatcher.callRequest('pty.spawn', {
      command: 'echo provider-owned',
      commandDelivery: 'provider'
    })

    vi.advanceTimersByTime(49)
    const term = mockPtySpawn.mock.results[0]?.value
    expect(handler.retainedStartupCommandCount).toBe(1)
    expect(handler.retainedStartupCommandBytes).toBe('echo provider-owned'.length)
    expect(term.write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    const submit = process.platform === 'win32' ? '\r' : '\n'
    expect(term.write).toHaveBeenCalledWith(`echo provider-owned${submit}`)
    expect(handler.retainedStartupCommandCount).toBe(0)
  })

  it.skipIf(process.platform === 'win32')(
    'emits shell-ready markers for renderer-delivered startup commands',
    async () => {
      const oldShell = process.env.SHELL
      const oldHome = process.env.HOME
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-shell-ready-spawn-'))

      process.env.SHELL = '/bin/bash'
      process.env.HOME = homeDir
      try {
        await dispatcher.callRequest('pty.spawn', {
          env: { HOME: homeDir },
          command: 'echo renderer-owned',
          startupCommandDelivery: 'shell-ready'
        })
      } finally {
        if (oldShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = oldShell
        }
        if (oldHome === undefined) {
          delete process.env.HOME
        } else {
          process.env.HOME = oldHome
        }
        rmSync(homeDir, { recursive: true, force: true })
      }

      const spawnOptions = mockPtySpawn.mock.calls[0]?.[2] as
        | { env?: Record<string, string> }
        | undefined
      expect(spawnOptions?.env?.ORCA_SHELL_FEATURES).toContain('ready')
      expect(handler.retainedStartupCommandCount).toBe(1)
      expect(handler.retainedStartupCommandBytes).toBe(0)
      vi.advanceTimersByTime(15_000)
      expect(handler.retainedStartupCommandCount).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'emits shell-ready markers for renderer-delivered Codex native prefill commands',
    async () => {
      const oldShell = process.env.SHELL
      const oldHome = process.env.HOME
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-codex-prefill-spawn-'))

      process.env.SHELL = '/bin/bash'
      process.env.HOME = homeDir
      try {
        await dispatcher.callRequest('pty.spawn', {
          env: { HOME: homeDir },
          command: "codex --prefill 'linked issue context'"
        })
      } finally {
        if (oldShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = oldShell
        }
        if (oldHome === undefined) {
          delete process.env.HOME
        } else {
          process.env.HOME = oldHome
        }
        rmSync(homeDir, { recursive: true, force: true })
      }

      const spawnOptions = mockPtySpawn.mock.calls[0]?.[2] as
        | { env?: Record<string, string> }
        | undefined
      expect(spawnOptions?.env?.ORCA_SHELL_FEATURES).toContain('ready')
      expect(handler.retainedStartupCommandCount).toBe(1)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'enables shell-ready marker env for provider-delivered startup commands',
    async () => {
      const oldShell = process.env.SHELL
      const oldHome = process.env.HOME
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-provider-ready-env-'))

      process.env.SHELL = '/bin/bash'
      process.env.HOME = homeDir
      try {
        await dispatcher.callRequest('pty.spawn', {
          env: { HOME: homeDir },
          command: 'echo provider-owned',
          commandDelivery: 'provider',
          startupCommandDelivery: 'shell-ready'
        })
      } finally {
        if (oldShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = oldShell
        }
        if (oldHome === undefined) {
          delete process.env.HOME
        } else {
          process.env.HOME = oldHome
        }
        rmSync(homeDir, { recursive: true, force: true })
      }

      const spawnOptions = mockPtySpawn.mock.calls[0]?.[2] as
        | { env?: Record<string, string> }
        | undefined
      expect(spawnOptions?.env?.ORCA_SHELL_FEATURES).toContain('ready')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'uses the sequenced startup command hint for provider shell-ready detection',
    async () => {
      const oldShell = process.env.SHELL
      const oldHome = process.env.HOME
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-provider-sequenced-ready-env-'))

      process.env.SHELL = '/bin/bash'
      process.env.HOME = homeDir
      try {
        await dispatcher.callRequest('pty.spawn', {
          env: {
            HOME: homeDir,
            [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: "codex --prefill 'linked issue context'"
          },
          command: 'bash -lc wait-for-setup-wrapper',
          commandDelivery: 'provider'
        })
      } finally {
        if (oldShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = oldShell
        }
        if (oldHome === undefined) {
          delete process.env.HOME
        } else {
          process.env.HOME = oldHome
        }
        rmSync(homeDir, { recursive: true, force: true })
      }

      const spawnOptions = mockPtySpawn.mock.calls[0]?.[2] as
        | { env?: Record<string, string> }
        | undefined
      expect(spawnOptions?.env?.ORCA_SHELL_FEATURES).toContain('ready')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'waits for the shell-ready marker before provider-delivered startup commands',
    async () => {
      let dataCallback: ((data: string) => void) | undefined
      const term = {
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn()
      }
      mockPtySpawn.mockReturnValue(term)
      const oldShell = process.env.SHELL
      const oldHome = process.env.HOME
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-provider-ready-spawn-'))

      process.env.SHELL = '/bin/bash'
      process.env.HOME = homeDir
      try {
        await dispatcher.callRequest('pty.spawn', {
          env: { HOME: homeDir },
          command: 'echo after-ready',
          commandDelivery: 'provider',
          startupCommandDelivery: 'shell-ready'
        })
      } finally {
        if (oldShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = oldShell
        }
        if (oldHome === undefined) {
          delete process.env.HOME
        } else {
          process.env.HOME = oldHome
        }
        rmSync(homeDir, { recursive: true, force: true })
      }

      vi.advanceTimersByTime(1499)
      expect(term.write).not.toHaveBeenCalled()

      dataCallback?.('\x1b]777;orca-shell-ready\x07user@remote $ ')
      vi.advanceTimersByTime(49)
      expect(term.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)

      expect(term.write).toHaveBeenCalledWith('echo after-ready\n')
      expect(handler.retainedStartupCommandCount).toBe(0)
      vi.advanceTimersByTime(8)
      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
        id: PTY_1,
        data: 'user@remote $ '
      })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'recovers provider delivery when startup exec replaces the relay wrapper',
    async () => {
      let dataCallback: ((data: string) => void) | undefined
      const term = {
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn()
      }
      mockPtySpawn.mockReturnValue(term)
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-provider-exec-spawn-'))
      const oldShell = process.env.SHELL
      process.env.SHELL = '/bin/bash'
      try {
        await dispatcher.callRequest('pty.spawn', {
          env: { HOME: homeDir },
          command: 'echo after-exec',
          commandDelivery: 'provider',
          startupCommandDelivery: 'shell-ready'
        })
      } finally {
        if (oldShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = oldShell
        }
        rmSync(homeDir, { recursive: true, force: true })
      }

      dataCallback?.(`\x1b]777;orca-shell-start:${process.pid}\x07\x1b[?2004hremote $ `)
      await vi.advanceTimersByTimeAsync(8)

      const promptOptions = mockCreateShellPromptReadinessProbe.mock.calls[0]?.[0] as {
        onPromptReady: () => void
      }
      expect(
        mockCreateShellPromptReadinessProbe.mock.results[0]?.value.notifyOutput
      ).toHaveBeenCalledWith('\x1b[?2004hremote $ ')
      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
        id: PTY_1,
        data: '\x1b[?2004hremote $ '
      })
      promptOptions.onPromptReady()
      await vi.advanceTimersByTimeAsync(50)

      expect(term.write).toHaveBeenCalledWith('echo after-exec\n')
      expect(handler.retainedStartupCommandCount).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'signals renderer delivery when startup exec replaces the relay wrapper',
    async () => {
      let dataCallback: ((data: string) => void) | undefined
      const term = {
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn()
      }
      mockPtySpawn.mockReturnValue(term)
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-renderer-exec-spawn-'))
      const oldShell = process.env.SHELL
      process.env.SHELL = '/bin/bash'
      try {
        await dispatcher.callRequest('pty.spawn', {
          env: { HOME: homeDir },
          command: 'echo after-exec',
          startupCommandDelivery: 'shell-ready'
        })
      } finally {
        if (oldShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = oldShell
        }
        rmSync(homeDir, { recursive: true, force: true })
      }

      dataCallback?.(`\x1b]777;orca-shell-start:${process.pid}\x07\x1b[?2004hremote $ `)
      await vi.advanceTimersByTimeAsync(8)
      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
        id: PTY_1,
        data: '\x1b[?2004hremote $ '
      })

      const promptOptions = mockCreateShellPromptReadinessProbe.mock.calls[0]?.[0] as {
        onPromptReady: () => void
      }
      promptOptions.onPromptReady()
      await vi.advanceTimersByTimeAsync(8)

      expect(term.write).not.toHaveBeenCalled()
      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
        id: PTY_1,
        data: '\x1b]777;orca-shell-ready\x07'
      })
      expect(handler.retainedStartupCommandCount).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'forwards the supported ready marker to renderer delivery',
    async () => {
      let dataCallback: ((data: string) => void) | undefined
      const term = {
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn()
      }
      mockPtySpawn.mockReturnValue(term)
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-renderer-ready-spawn-'))
      const oldShell = process.env.SHELL
      process.env.SHELL = '/bin/bash'
      try {
        await dispatcher.callRequest('pty.spawn', {
          env: { HOME: homeDir },
          command: 'echo after-ready',
          startupCommandDelivery: 'shell-ready'
        })
      } finally {
        if (oldShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = oldShell
        }
        rmSync(homeDir, { recursive: true, force: true })
      }

      dataCallback?.(
        `\x1b]777;orca-shell-start:${process.pid}\x07\x1b]777;orca-shell-ready\x07remote $ `
      )
      await vi.advanceTimersByTimeAsync(8)

      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
        id: PTY_1,
        data: '\x1b]777;orca-shell-ready\x07remote $ '
      })
      expect(handler.retainedStartupCommandCount).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'releases split renderer readiness through one completed path',
    async () => {
      let dataCallback: ((data: string) => void) | undefined
      const term = {
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn()
      }
      mockPtySpawn.mockReturnValue(term)
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-renderer-split-ready-spawn-'))
      const oldShell = process.env.SHELL
      process.env.SHELL = '/bin/bash'
      try {
        await dispatcher.callRequest('pty.spawn', {
          env: { HOME: homeDir },
          command: 'echo after-ready',
          startupCommandDelivery: 'shell-ready'
        })
      } finally {
        if (oldShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = oldShell
        }
        rmSync(homeDir, { recursive: true, force: true })
      }

      dataCallback?.(`\x1b]777;orca-shell-start:${process.pid}\x07\x1b]777;orca-shell-ready`)
      dataCallback?.('\x07remote $ ')
      await vi.advanceTimersByTimeAsync(8)

      const probe = mockCreateShellPromptReadinessProbe.mock.results[0]?.value
      expect(probe.notifyOutput).not.toHaveBeenCalled()
      expect(probe.dispose).toHaveBeenCalledOnce()
      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
        id: PTY_1,
        data: '\x1b]777;orca-shell-ready\x07remote $ '
      })
      expect(handler.retainedStartupCommandCount).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not retain renderer readiness state for unsupported shells',
    async () => {
      const oldShell = process.env.SHELL
      process.env.SHELL = '/bin/sh'
      try {
        await dispatcher.callRequest('pty.spawn', {
          command: 'x'.repeat(256 * 1024),
          startupCommandDelivery: 'shell-ready'
        })
      } finally {
        if (oldShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = oldShell
        }
      }

      const spawnOptions = mockPtySpawn.mock.calls[0]?.[2] as
        | { env?: Record<string, string> }
        | undefined
      expect(spawnOptions?.env?.ORCA_SHELL_FEATURES).toBe('')
      expect(handler.retainedStartupCommandCount).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'flushes held shell-ready marker bytes when provider delivery falls back',
    async () => {
      let dataCallback: ((data: string) => void) | undefined
      const term = {
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn()
      }
      mockPtySpawn.mockReturnValue(term)
      const oldShell = process.env.SHELL
      const oldHome = process.env.HOME
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-provider-fallback-spawn-'))

      process.env.SHELL = '/bin/bash'
      process.env.HOME = homeDir
      let spawn!: { id: string; incarnationId: string }
      try {
        spawn = await spawnPty({
          env: { HOME: homeDir },
          command: 'echo fallback',
          commandDelivery: 'provider',
          startupCommandDelivery: 'shell-ready'
        })
      } finally {
        if (oldShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = oldShell
        }
        if (oldHome === undefined) {
          delete process.env.HOME
        } else {
          process.env.HOME = oldHome
        }
        rmSync(homeDir, { recursive: true, force: true })
      }

      dataCallback?.('\x1b]777;orca-shell-ready')
      vi.advanceTimersByTime(1500)

      expect(term.write).toHaveBeenCalledWith('echo fallback\n')
      vi.advanceTimersByTime(8)
      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
        id: PTY_1,
        data: '\x1b]777;orca-shell-ready'
      })

      const result = await attachPty({
        id: PTY_1,
        suppressReplayNotification: true
      })
      expect(result).toEqual({
        incarnationId: spawn.incarnationId,
        replay: '\x1b]777;orca-shell-ready'
      })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'releases renderer readiness state when attach reaps a dead shell',
    async () => {
      const oldShell = process.env.SHELL
      const oldHome = process.env.HOME
      const homeDir = mkdtempSync(join(tmpdir(), 'relay-dead-shell-ready-spawn-'))
      process.env.SHELL = '/bin/bash'
      process.env.HOME = homeDir
      try {
        await dispatcher.callRequest('pty.spawn', {
          env: { HOME: homeDir },
          command: 'x'.repeat(256 * 1024),
          startupCommandDelivery: 'shell-ready'
        })
      } finally {
        if (oldShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = oldShell
        }
        if (oldHome === undefined) {
          delete process.env.HOME
        } else {
          process.env.HOME = oldHome
        }
        rmSync(homeDir, { recursive: true, force: true })
      }
      expect(handler.retainedStartupCommandCount).toBe(1)

      const aliveSpy = vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(false)
      try {
        await expect(dispatcher.callRequest('pty.attach', { id: PTY_1 })).rejects.toThrow(
          `PTY "${PTY_1}" not found`
        )
      } finally {
        aliveSpy.mockRestore()
      }

      expect(handler.retainedStartupCommandCount).toBe(0)
      vi.advanceTimersByTime(15_000)
      expect(handler.retainedStartupCommandCount).toBe(0)
    }
  )

  it('does not submit provider-delivered commands for stale spawn responses', async () => {
    const killSpy = vi.fn()
    const term = { ...mockPtyInstance, kill: killSpy, onData: vi.fn(), onExit: vi.fn() }
    mockPtySpawn.mockReturnValue(term)

    await dispatcher.callRequest(
      'pty.spawn',
      { command: 'echo stale', commandDelivery: 'provider' },
      { isStale: () => mockPtySpawn.mock.calls.length > 0 }
    )

    vi.advanceTimersByTime(50)
    expect(term.write).not.toHaveBeenCalled()
    expect(handler.retainedStartupCommandCount).toBe(0)
    expect(killSpy).toHaveBeenCalledWith('SIGTERM')
  })

  it('releases pending provider-delivered commands on shutdown before delivery', async () => {
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    const killSpy = vi.fn()
    const term = {
      ...mockPtyInstance,
      kill: killSpy,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    }
    mockPtySpawn.mockReturnValue(term)

    await dispatcher.callRequest('pty.spawn', {
      command: 'echo stop-before-run',
      commandDelivery: 'provider'
    })
    expect(handler.retainedStartupCommandCount).toBe(1)

    const shutdown = dispatcher.callRequest('pty.shutdown', { id: PTY_1, immediate: true })
    onExitCb!({ exitCode: 137 })
    await shutdown
    vi.advanceTimersByTime(50)

    expect(handler.retainedStartupCommandCount).toBe(0)
    expect(term.write).not.toHaveBeenCalled()
    expect(killSpy).toHaveBeenCalledWith('SIGKILL')
  })
})
