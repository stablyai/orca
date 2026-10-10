import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { toWindowsWslPath } from '../wsl'
import { CodexManagedHomePath } from './codex-managed-home-path'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('WSL removal ownership script', () => {
  it('allows only an empty interrupted cleanup and refuses unreadable or credential-bearing homes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-wsl-removal-'))
    directories.push(directory)
    const root = join(directory, '.local', 'share', 'orca', 'codex-accounts')
    const home = join(root, 'account-1', 'home')
    mkdirSync(home, { recursive: true })
    let script = ''
    const paths = new CodexManagedHomePath((_distro, captured) => {
      script = captured.replace(
        'managed_root="${HOME%/}/.local/share/orca/codex-accounts"',
        `managed_root=${quotePosixShell(root)}`
      )
      return home
    })
    const platform = process.platform
    const capture = (allowEmptyHome: boolean): string => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      try {
        paths.assert(toWindowsWslPath(home, 'Ubuntu'), 'account-1', { allowEmptyHome })
        return script
      } finally {
        Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      }
    }
    const run = (command: string) =>
      runProcess({ program: 'bash', args: ['-c', command], timeoutMs: 5000 })
    const removalScript = capture(true)
    expect((await run(removalScript)).code).toBe(0)
    expect((await run(capture(false))).code).not.toBe(0)
    expect((await run(`find() { return 1; }\n${removalScript}`)).code).not.toBe(0)
    writeFileSync(join(home, 'auth.json'), 'secret')
    expect((await run(removalScript)).code).not.toBe(0)
    writeFileSync(join(home, '.orca-managed-home'), 'wrong-owner\n')
    expect((await run(removalScript)).code).not.toBe(0)
    writeFileSync(join(home, '.orca-managed-home'), 'account-1\n')
    expect((await run(removalScript)).code).toBe(0)
  })
})
