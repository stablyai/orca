import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WslSpec } from '../wsl/execution/wsl-runner'
import { credential } from './native-account-test-fixtures'
import { createAntigravityWslCredentialBackend } from './native-wsl-credentials'

// The guest scripts need GNU stat; run them where the local sh has it (Linux CI).
const gnuStat = spawnSync('stat', ['-c', '%a', '/'], { encoding: 'utf8' }).status === 0

function guestIn(home: string) {
  return vi.fn(async (spec: WslSpec) => {
    const result = spawnSync('sh', ['-c', spec.script!, '--', ...(spec.args ?? [])], {
      env: { PATH: process.env.PATH, HOME: home },
      input: spec.input,
      encoding: 'utf8'
    })
    return { code: result.status, stdout: result.stdout, timedOut: false }
  })
}

describe('Antigravity credentials in a WSL distro', () => {
  it('never runs a guest command while the distro is stopped or unverifiable', async () => {
    const run = vi.fn()
    for (const state of ['stopped', 'unverifiable'] as const) {
      const backend = createAntigravityWslCredentialBackend('Ubuntu', {
        runningState: async () => state,
        run
      })
      await expect(backend.read()).rejects.toThrow('WSL (Ubuntu)')
      await expect(backend.write(credential('a'), null)).rejects.toThrow('WSL (Ubuntu)')
    }
    expect(run).not.toHaveBeenCalled()
  })

  it.runIf(gnuStat)(
    'writes privately, swaps only the expected file, and reads it back',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'agy-wsl-'))
      const file = join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
      const run = guestIn(home)
      const backend = createAntigravityWslCredentialBackend('Ubuntu', {
        runningState: async () => 'running',
        run
      })
      expect(await backend.read()).toBeNull()

      await backend.write(credential('a'), null)
      expect(readFileSync(file, 'utf8')).toBe(credential('a'))
      expect(statSync(file).mode & 0o777).toBe(0o600)
      // Credentials go over stdin, never the command line.
      expect(run.mock.calls.every(([spec]) => !spec.args?.includes(credential('a')))).toBe(true)

      await expect(backend.write(credential('b'), credential('c'))).rejects.toThrow('changed')
      await expect(backend.write(credential('b'), null)).rejects.toThrow('changed')
      expect(readFileSync(file, 'utf8')).toBe(credential('a'))

      await backend.write(credential('b'), credential('a'))
      expect((await backend.read())?.identity?.subject).toBe('b')

      chmodSync(file, 0o644)
      await expect(backend.read()).rejects.toThrow('could not be read safely')
    }
  )

  it.runIf(gnuStat)('refuses a credential path that is not a regular file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-wsl-'))
    mkdirSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), {
      recursive: true
    })
    writeFileSync(join(home, 'unused'), '')
    const backend = createAntigravityWslCredentialBackend('Ubuntu', {
      runningState: async () => 'running',
      run: guestIn(home)
    })
    await expect(backend.read()).rejects.toThrow('could not be read safely')
    await expect(backend.write(credential('a'), null)).rejects.toThrow('changed')
  })
})
