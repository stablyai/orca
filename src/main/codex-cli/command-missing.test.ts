import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isCliCommandMissing } from './command'

// The host's own install directories are this machine's; each case names the only places it has.
vi.mock('../../shared/system-cli-install-dirs', () => ({
  getSystemCliInstallDirectories: () => []
}))

function makeExecutable(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  chmodSync(path, 0o755)
}

describe('isCliCommandMissing', () => {
  it('trusts a path the resolver found, without looking', () => {
    expect(isCliCommandMissing('codex', '/opt/codex/bin/codex', {})).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    "finds the bare name on the spawn's PATH or in its home's version manager, else calls it missing",
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-cli-missing-'))
      makeExecutable(join(root, 'shell-bin', 'codex'))
      makeExecutable(join(root, 'home', '.volta', 'bin', 'codex'))
      const missing = (env: NodeJS.ProcessEnv) => isCliCommandMissing('codex', 'codex', env)

      expect(missing({ PATH: join(root, 'shell-bin'), HOME: join(root, 'nobody') })).toBe(false)
      expect(missing({ PATH: join(root, 'empty'), HOME: join(root, 'home') })).toBe(false)
      expect(missing({ PATH: join(root, 'empty'), HOME: join(root, 'nobody') })).toBe(true)
    }
  )

  // Windows reads the first `Path` spelling in the block and runs `.cmd`/`.exe` shims.
  it.each([
    ['codex.cmd', { Path: 'bin' }, false],
    ['codex.exe', { PATH: 'bin' }, false],
    ['codex.cmd', { PATH: 'empty', Path: 'bin' }, true],
    ['codex.sh', { Path: 'bin' }, true]
  ] as const)('on Windows, %s on %j is missing: %s', (file, pathKeys, missing) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-cli-missing-win-'))
    makeExecutable(join(root, 'bin', file))
    const env: NodeJS.ProcessEnv = { USERPROFILE: join(root, 'nobody') }
    for (const [key, dir] of Object.entries(pathKeys)) {
      env[key] = join(root, dir)
    }
    expect(isCliCommandMissing('codex', 'codex', env, 'win32')).toBe(missing)
  })
})
