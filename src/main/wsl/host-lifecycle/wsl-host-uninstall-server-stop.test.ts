import '../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslHostServerStop } from '../../../shared/wsl-host-types'

const { execCommand, decommission, dispose } = vi.hoisted(() => ({
  execCommand: vi.fn<(conn: unknown, command: string) => Promise<string>>(),
  decommission: vi.fn(),
  dispose: vi.fn()
}))
vi.mock('../../ssh/remote-exec/remote-exec-command', () => ({ execCommand }))
const { transportOptions } = vi.hoisted((): { transportOptions: unknown[] } => ({
  transportOptions: []
}))
vi.mock('../orcad/wsl-orcad-host-transport', () => ({
  createWslOrcadHostTransport: (options: unknown) => {
    transportOptions.push(options)
    return { dispose }
  }
}))
vi.mock('./wsl-host-server-stop', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  decommissionWslHostOrcad: () => decommission
}))

import {
  buildCensusCommand,
  buildCloseTerminalsCommand,
  stopWslHostServersForUninstall,
  type WslHostUninstallStopDependencies
} from './wsl-host-uninstall-server-stop'

function deps(
  overrides: Partial<WslHostUninstallStopDependencies> = {}
): WslHostUninstallStopDependencies {
  return {
    distros: () => ['Ubuntu', 'Debian'],
    listRunning: async () => ['ubuntu'],
    stop: vi.fn(async (): Promise<WslHostServerStop> => ({ stopped: true })),
    ...overrides
  }
}

describe('stopWslHostServersForUninstall', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('waits for an aborted stop to unwind before returning, so the holder outlives it', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    const d = deps({
      timeoutMs: 1_000,
      stop: (_distro, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            setTimeout(() => {
              events.push('stop-unwound')
              resolve({ stopped: false, reason: 'aborted', verdict: 'unverifiable' })
            }, 500)
          })
        })
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const done = stopWslHostServersForUninstall(d).then(() => events.push('returned'))
    await vi.advanceTimersByTimeAsync(1_500)
    await done

    expect(events).toEqual(['stop-unwound', 'returned'])
  })

  it('gives up on a distro that never answers, aborting its work', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const d = deps({
      timeoutMs: 1_000,
      stop: (_distro, s) => {
        signal = s
        return new Promise(() => {})
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const done = stopWslHostServersForUninstall(d)
    // The budget, then the bounded wait for the aborted stop to unwind.
    await vi.advanceTimersByTimeAsync(3_000)
    await done

    expect(signal?.aborted).toBe(true)
    expect(log).toHaveBeenCalledWith(
      '[wsl] uninstall could not stop the Ubuntu host server: timed out after 1000 ms'
    )
  })
})

describe('guest commands under a real POSIX shell', () => {
  const describeOnPosix = process.platform === 'win32' ? describe.skip : describe
  describeOnPosix('with a fake server CLI', () => {
    let home: string
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'orca-uninstall-guest-'))
      mkdirSync(join(home, '.orca', 'cli', 'bin'), { recursive: true })
    })
    afterEach(() => rmSync(home, { recursive: true, force: true }))

    function fakeCli(script: string): void {
      const path = join(home, '.orca', 'cli', 'bin', 'orca')
      writeFileSync(path, `#!/bin/sh\n${script}\n`)
      chmodSync(path, 0o755)
    }
    const sh = (command: string) =>
      spawnSync('/bin/sh', ['-c', command], {
        env: { ...process.env, HOME: home },
        encoding: 'utf8'
      })

    it('closes each worktree and reports every exit code', () => {
      fakeCli('case "$4" in *w1) exit 3 ;; esac; echo "$@" >> "$HOME/closed"')

      const out = sh(buildCloseTerminalsCommand(['repo::/w0', 'repo::/w1', "repo::/it's"]))

      expect(out.stdout.split('\n').filter(Boolean).sort()).toEqual([
        'UNINSTALL_CLOSE 0 0',
        'UNINSTALL_CLOSE 1 3',
        'UNINSTALL_CLOSE 2 0'
      ])
      expect(readFileSync(join(home, 'closed'), 'utf8')).toContain("id:repo::/it's")
    })

    it('counts live terminals, and reports a failing list as unknown', () => {
      fakeCli('echo \'{"result":{"terminals":[{"handle":"a"},{"handle":"b"}]}}\'')
      expect(sh(buildCensusCommand(0)).stdout.trim()).toBe('UNINSTALL_CENSUS 2')

      fakeCli('echo \'{"result":{"terminals":[]}}\'')
      expect(sh(buildCensusCommand(0)).stdout.trim()).toBe('UNINSTALL_CENSUS 0')

      fakeCli('exit 1')
      expect(sh(buildCensusCommand(0)).stdout.trim()).toBe('UNINSTALL_CENSUS unknown')
    })
  })
})
