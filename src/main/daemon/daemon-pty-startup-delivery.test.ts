import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import * as localPtyUtils from '../providers/local-pty-utils'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor,
  type DaemonAdapterHarness,
  type SpawnSubprocess
} from './daemon-pty-adapter-test-harness'
import { buildLaunchFilePointer, carryInLaunchFile } from '../../shared/launch-prompt-file'

const itOnPosix = process.platform === 'win32' ? it.skip : it

describe('DaemonPtyAdapter startup delivery', () => {
  let harness: DaemonAdapterHarness
  let adapter: DaemonAdapterHarness['adapter']
  let dir: string
  let lastSubprocess: ReturnType<typeof createMockSubprocess>
  let lastSpawnOpts: Parameters<SpawnSubprocess>[0] | null
  let nextShellPath: string | undefined

  beforeEach(async () => {
    lastSpawnOpts = null
    nextShellPath = undefined
    harness = await startDaemonAdapterHarness((opts) => {
      lastSpawnOpts = opts
      lastSubprocess = Object.assign(
        createMockSubprocess(),
        nextShellPath ? { shellPath: nextShellPath } : {}
      )
      return lastSubprocess
    })
    adapter = harness.adapter
    dir = harness.dir
  })

  afterEach(async () => {
    adapter.dispose()
    await harness.server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  itOnPosix('preserves the existing fast-start timing for fish', async () => {
    // The mock subprocess represents installed fish even on hosts without it.
    const resolveShell = vi
      .spyOn(localPtyUtils, 'resolveUnixShellPath')
      .mockReturnValue('/usr/bin/fish')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await adapter.spawn({
        cols: 80,
        rows: 24,
        command: 'codex',
        env: { SHELL: '/usr/bin/fish' }
      })
      await vi.advanceTimersByTimeAsync(299)
      expect(lastSubprocess.write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(lastSubprocess.write).toHaveBeenCalledExactlyOnceWith('codex\r')
      expect(lastSpawnOpts).not.toEqual(
        expect.objectContaining({ startupCommandDelivery: 'shell-ready' })
      )
    } finally {
      vi.useRealTimers()
      resolveShell.mockRestore()
    }
  })

  itOnPosix.for(['environment', 'override'] as const)(
    'waits for the fallback shell when the %s shell is missing',
    async (source, context) => {
      const missingShell = join(dir, 'missing-fish')
      const fallbackName = basename(localPtyUtils.resolveUnixShellPath(missingShell))
      context.skip(!['bash', 'zsh'].includes(fallbackName), 'Requires a Bash/zsh fallback')
      await adapter.spawn({
        cols: 80,
        rows: 24,
        command: 'codex',
        env: { SHELL: source === 'environment' ? missingShell : '/bin/sh' },
        ...(source === 'override' ? { shellOverride: missingShell } : {})
      })
      await new Promise((resolve) => setTimeout(resolve, 350))
      expect(lastSubprocess.write).not.toHaveBeenCalled()
      expect(lastSpawnOpts).toEqual(
        expect.objectContaining({ startupCommandDelivery: 'shell-ready' })
      )
      lastSubprocess._simulateData('\x1b]777;orca-shell-ready\x07\r\nuser@host $ ')
      await waitFor(() => vi.mocked(lastSubprocess.write).mock.calls.length > 0)
      expect(lastSubprocess.write).toHaveBeenCalledExactlyOnceWith('codex\r')
    }
  )

  itOnPosix.each([
    { command: 'codex' },
    { command: 'codex', startupCommandDelivery: 'fast' as const },
    { command: "codex 'linked issue context'", startupCommandDelivery: 'shell-ready' as const }
  ])('waits past 300ms and submits once after readiness: %j', async (startup) => {
    await adapter.spawn({ cols: 80, rows: 24, ...startup, env: { SHELL: '/bin/zsh' } })

    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(lastSubprocess.write).not.toHaveBeenCalled()
    expect(lastSpawnOpts).toEqual(
      expect.objectContaining({ startupCommandDelivery: 'shell-ready' })
    )
    lastSubprocess._simulateData('\x1b]777;orca-shell-ready\x07')
    lastSubprocess._simulateData('\r\nuser@host $ ')

    await waitFor(() => vi.mocked(lastSubprocess.write).mock.calls.length > 0)
    expect(lastSubprocess.write).toHaveBeenCalledExactlyOnceWith(`${startup.command}\r`)
  })

  itOnPosix('types only the short line that sources a staged launch line', async () => {
    const stagingDir = join(dir, 'tmp')
    mkdirSync(stagingDir)
    vi.stubEnv('TMPDIR', stagingDir)
    nextShellPath = '/bin/zsh'
    try {
      const command = `claude '${'x'.repeat(600)}'`
      await adapter.spawn({
        cols: 80,
        rows: 24,
        command,
        env: { SHELL: '/bin/zsh' }
      })
      lastSubprocess._simulateData('\x1b]777;orca-shell-ready\x07\r\nuser@host $ ')
      await waitFor(() => vi.mocked(lastSubprocess.write).mock.calls.length > 0)
      const [script] = readdirSync(stagingDir)
      expect(lastSubprocess.write).toHaveBeenCalledExactlyOnceWith(
        `. '${join(stagingDir, script)}'\r`
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  itOnPosix('writes a launch file before typing the line that names it', async () => {
    const stagingDir = join(dir, 'tmp')
    mkdirSync(stagingDir)
    vi.stubEnv('TMPDIR', stagingDir)
    nextShellPath = '/bin/zsh'
    try {
      const { prompt, launchFile } = carryInLaunchFile('secret brief')
      await adapter.spawn({
        cols: 80,
        rows: 24,
        command: `claude '${prompt}'`,
        launchFile,
        env: { SHELL: '/bin/zsh' }
      })
      const launchDir = readdirSync(stagingDir).find((name) => name.startsWith('orca-launch-file-'))
      const path = join(realpathSync(stagingDir), launchDir ?? '', 'task-context.md')
      expect(readFileSync(path, 'utf8')).toBe('secret brief')
      expect(lastSpawnOpts?.command).toBe(`claude '${buildLaunchFilePointer(path)}'`)
      lastSubprocess._simulateData('\x1b]777;orca-shell-ready\x07\r\nuser@host $ ')
      await waitFor(() => vi.mocked(lastSubprocess.write).mock.calls.length > 0)
      expect(lastSubprocess.write).toHaveBeenCalledExactlyOnceWith(
        `claude '${buildLaunchFilePointer(path)}'\r`
      )
      lastSubprocess._simulateExit(0)
      await waitFor(() => !existsSync(path))
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
