import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildLocalCommandEnv,
  executeLocalCommand,
  localCommandsSupported,
  resolveLocalCommandCwd
} from './local-command-executor'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe.skipIf(!localCommandsSupported())('local command executor', () => {
  it('passes none of the app environment except PATH, HOME and locale', async () => {
    const env = buildLocalCommandEnv(
      '/opt/homebrew/bin:/usr/bin:/bin',
      { ANTHROPIC_API_KEY: 'sk-secret', GITHUB_TOKEN: 'ghp_x', LANG: 'en_US.UTF-8', USER: 'me' },
      '/Users/me'
    )
    const result = await executeLocalCommand({
      command: 'env',
      cwd: tmpdir(),
      timeoutSec: 10,
      env
    })
    expect(result.stdout).not.toContain('sk-secret')
    expect(result.stdout).not.toContain('ghp_x')
    expect(result.stdout).toContain('PATH=/opt/homebrew/bin:/usr/bin:/bin')
    expect(result.stdout).toContain('HOME=/Users/me')
    expect(result.stdout).toContain('LANG=en_US.UTF-8')
  })

  it('cuts output at 128 KB per stream and says so', async () => {
    const result = await executeLocalCommand({
      command: 'head -c 300000 /dev/zero | tr "\\0" a',
      cwd: tmpdir(),
      timeoutSec: 10,
      env: buildLocalCommandEnv(undefined)
    })
    expect(result.stdout.length).toBe(128 * 1024)
    expect(result.stdoutBytes).toBe(300000)
    expect(result.truncated).toBe(true)
  })

  it('stops a command at its timeout', async () => {
    const result = await executeLocalCommand({
      command: 'sleep 30',
      cwd: tmpdir(),
      timeoutSec: 1,
      env: buildLocalCommandEnv(undefined)
    })
    expect(result.timedOut).toBe(true)
    expect(result.durationMs).toBeLessThan(10_000)
  })

  it('resolves ~ and refuses a folder that does not exist', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lc-home-'))
    dirs.push(home)
    expect(await resolveLocalCommandCwd('~', home)).toBe(realpathSync(home))
    expect(await resolveLocalCommandCwd('~/nope', home)).toBeNull()
    expect(await resolveLocalCommandCwd('relative/path', home)).toBeNull()
  })

  it('reports soon after the shell exits even if a detached process holds its output open', async () => {
    const result = await executeLocalCommand({
      command: `perl -MPOSIX -e 'setsid(); sleep 30' & echo done`,
      cwd: tmpdir(),
      timeoutSec: 20,
      env: buildLocalCommandEnv(undefined)
    })
    expect(result.stdout).toBe('done\n')
    expect(result.timedOut).toBe(false)
    expect(result.durationMs).toBeLessThan(5_000)
  })
})
