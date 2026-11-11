import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureLoginShellEnvironment,
  resetLoginShellEnvironmentCacheForTests
} from './login-shell-environment'

// A detached probe is out of reach of terminal signals, so nothing its rc starts may outlive the probe's owner.
describe.skipIf(process.platform === 'win32')('a login shell probe left running', () => {
  let home: string
  let pidFile: string

  const rcChildPid = (): number => Number(readFileSync(pidFile, 'utf8').trim())
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const writeProfile = (afterStart: string): void => {
    writeFileSync(
      join(home, '.bash_profile'),
      `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; ${afterStart}\n`
    )
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-shell-probe-lifetime-'))
    pidFile = join(home, 'rc-child.pid')
    resetLoginShellEnvironmentCacheForTests()
  })

  afterEach(() => {
    try {
      // Only the rc child this test recorded; a passing run already killed it.
      process.kill(rcChildPid(), 'SIGKILL')
    } catch {
      // Gone, or never started.
    }
    rmSync(home, { recursive: true, force: true })
  })

  it.each([
    ['while its shell still runs', 'wait;'],
    // The rc child keeps the probe's stdout open after the shell exits.
    ['after its shell exited', '']
  ])('takes what its rc started down with it on timeout (%s)', async (_when, afterStart) => {
    writeProfile(afterStart)
    const capture = await captureLoginShellEnvironment({
      shellOverride: '/bin/bash',
      env: { HOME: home, PATH: process.env.PATH ?? '' },
      timeoutMs: 3_000
    })
    expect(capture.status).toBe('fallback')
    const pid = rcChildPid()
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false))
  })

  it.each([
    ['login-environment', `captureLoginShellEnvironment({ shellOverride: '/bin/bash' })`],
    ['path', `hydrateShellPath({ shellOverride: '/bin/bash' })`]
  ])('takes what its rc started down when its owner is stopped (%s)', async (_name, call) => {
    // The rc signals the owner itself, so the probe is mid-run when the owner goes.
    writeProfile('kill -TERM $PPID; wait;')
    const fixture = join(home, 'owner.cjs')
    await build({
      stdin: {
        contents: `
          import { captureLoginShellEnvironment } from ${JSON.stringify(resolve('src/main/startup/login-shell-environment.ts'))};
          import { hydrateShellPath } from ${JSON.stringify(resolve('src/main/startup/hydrate-shell-path.ts'))};
          // As orcad and Electron do: INT/TERM end in an exit.
          process.on('SIGTERM', () => process.exit(143));
          void ${call};
        `,
        resolveDir: process.cwd(),
        loader: 'ts'
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      outfile: fixture,
      logLevel: 'silent'
    })
    const owner = await runProcess({
      program: process.execPath,
      args: [fixture],
      env: { HOME: home, PATH: process.env.PATH ?? '', SHELL: '/bin/bash' },
      timeoutMs: 20_000
    })
    expect(owner.code).toBe(143)
    const pid = rcChildPid()
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false))
  })
})
