import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isEntryPoint, resolvePnpmInvocation } from './build-native-for-platform.mjs'

const sourceScriptPath = fileURLToPath(new URL('./build-native-for-platform.mjs', import.meta.url))

// Why: running the script for real builds Swift on darwin and the CLI launcher on win32;
// only linux reaches the cheap early-exit branch.
const itLinux = process.platform === 'linux' ? it : it.skip

// Why: linking a throwaway copy rather than config/scripts keeps cleanup from ever pointing
// at the repo.
function withSymlinkedCopy(assert) {
  const root = mkdtempSync(join(tmpdir(), 'orca-native-entry-'))
  try {
    const realDir = join(root, 'real')
    mkdirSync(realDir)
    const realScript = join(realDir, 'build-native-for-platform.mjs')
    copyFileSync(sourceScriptPath, realScript)
    symlinkSync(realDir, join(root, 'link'), 'junction')

    assert({ realScript, linkedScript: join(root, 'link', 'build-native-for-platform.mjs') })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('build:native pnpm invocation', () => {
  it('runs a JS npm_execpath through Node so the pinned pnpm version is kept', () => {
    const npmExecPath = '/repo/node_modules/pnpm/bin/pnpm.cjs'

    expect(resolvePnpmInvocation('build:computer-macos', npmExecPath, 'darwin')).toEqual({
      command: process.execPath,
      args: [npmExecPath, 'run', 'build:computer-macos'],
      shell: false
    })
  })

  it('executes a standalone @pnpm/exe npm_execpath directly instead of parsing it as JS', () => {
    const npmExecPath = '/Users/dev/.local/share/mise/installs/pnpm/10.24.0/pnpm'

    expect(resolvePnpmInvocation('build:computer-macos', npmExecPath, 'darwin')).toEqual({
      command: npmExecPath,
      args: ['run', 'build:computer-macos'],
      shell: false
    })
  })

  it('falls back to the pnpm on PATH when npm_execpath is unset', () => {
    expect(resolvePnpmInvocation('build:computer-macos', undefined, 'darwin')).toEqual({
      command: 'pnpm',
      args: ['run', 'build:computer-macos'],
      shell: false
    })
  })

  // Why: build:native exits on win32 before it runs pnpm, so these pin the resolver
  // contract only; they are not evidence that Windows reaches this code.
  describe('win32 resolver contract, unreachable from the build:native entry path', () => {
    it('quotes and shells out the pnpm.cmd fallback when npm_execpath is unset', () => {
      expect(resolvePnpmInvocation('build:computer-macos', '', 'win32')).toEqual({
        command: '"pnpm.cmd"',
        args: ['run', 'build:computer-macos'],
        shell: true
      })
    })

    it('quotes and shells out a .cmd npm_execpath that Node refuses to spawn', () => {
      const npmExecPath = 'C:\\Program Files\\nodejs\\pnpm.cmd'

      expect(resolvePnpmInvocation('build:computer-macos', npmExecPath, 'win32')).toEqual({
        command: `"${npmExecPath}"`,
        args: ['run', 'build:computer-macos'],
        shell: true
      })
    })
  })
})

describe('build:native entry guard', () => {
  it('matches an entry path reached through a symlinked directory', () => {
    withSymlinkedCopy(({ realScript, linkedScript }) => {
      expect(linkedScript).not.toBe(realScript)
      expect(isEntryPoint(linkedScript, realScript)).toBe(true)
    })
  })

  it('rejects a missing argv[1] and an unrelated entry path', () => {
    expect(isEntryPoint(undefined, sourceScriptPath)).toBe(false)
    expect(isEntryPoint(process.execPath, sourceScriptPath)).toBe(false)
  })

  itLinux('runs the build flow when spawned through a symlinked path', () => {
    withSymlinkedCopy(({ linkedScript }) => {
      const result = spawnSync(process.execPath, [linkedScript], { encoding: 'utf8' })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('[native-build] no macOS native computer build required')
    })
  })
})
