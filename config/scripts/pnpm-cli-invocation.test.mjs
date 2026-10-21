import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'

const nodeExecPath = '/usr/local/bin/node'

describe('resolvePnpmCliInvocation', () => {
  // Why: config/vitest.config.ts does not set unstubEnvs, so stubs would leak into later cases.
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('runs a JS CLI through node so older pnpm.cjs still works', () => {
    expect(
      resolvePnpmCliInvocation({
        npmExecPath: '/Users/runner/setup-pnpm/node_modules/pnpm/bin/pnpm.cjs',
        nodeExecPath,
        platform: 'darwin'
      })
    ).toEqual({
      command: nodeExecPath,
      prefixArgs: ['/Users/runner/setup-pnpm/node_modules/pnpm/bin/pnpm.cjs'],
      shell: false
    })
  })

  it('executes pnpm 12 native binaries directly instead of through node', () => {
    expect(
      resolvePnpmCliInvocation({
        npmExecPath: '/Users/runner/setup-pnpm/pnpm',
        nodeExecPath,
        platform: 'darwin'
      })
    ).toEqual({
      command: '/Users/runner/setup-pnpm/pnpm',
      prefixArgs: [],
      shell: false
    })
  })

  it('does not wrap a Windows native pnpm.exe in node', () => {
    expect(
      resolvePnpmCliInvocation({
        npmExecPath: 'C:\\hostedtoolcache\\pnpm.exe',
        nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
        platform: 'win32'
      })
    ).toEqual({
      command: 'C:\\hostedtoolcache\\pnpm.exe',
      prefixArgs: [],
      shell: false
    })
  })

  it('shells out for every Windows batch wrapper extension and casing', () => {
    for (const npmExecPath of [
      'C:\\Users\\runner\\pnpm.cmd',
      'C:\\Users\\runner\\pnpm.bat',
      'C:\\tools\\PNPM.CMD',
      'C:\\tools\\PNPM.BAT'
    ]) {
      expect(
        resolvePnpmCliInvocation({
          npmExecPath,
          nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
          platform: 'win32'
        })
      ).toEqual({ command: npmExecPath, prefixArgs: [], shell: true })
    }
  })

  // Why: only cmd.exe needs the shell hop; a .cmd-named path elsewhere must still exec directly.
  it('does not shell out for a .cmd path on a non-Windows platform', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(
        resolvePnpmCliInvocation({ npmExecPath: '/opt/pnpm.cmd', nodeExecPath, platform })
      ).toEqual({ command: '/opt/pnpm.cmd', prefixArgs: [], shell: false })
    }
  })

  it('treats .js and .mjs CLIs the same as .cjs', () => {
    for (const npmExecPath of ['/opt/pnpm.js', '/opt/pnpm.mjs']) {
      expect(resolvePnpmCliInvocation({ npmExecPath, nodeExecPath, platform: 'linux' })).toEqual({
        command: nodeExecPath,
        prefixArgs: [npmExecPath],
        shell: false
      })
    }
  })

  // Why: `npmExecPath: undefined` would hit the destructuring default and read the ambient
  // npm_execpath, so an explicit empty string is the only env-independent way to force this branch.
  it('falls back to PATH pnpm when npm_execpath is empty', () => {
    expect(resolvePnpmCliInvocation({ npmExecPath: '', nodeExecPath, platform: 'darwin' })).toEqual(
      { command: 'pnpm', prefixArgs: [], shell: false }
    )
    expect(resolvePnpmCliInvocation({ npmExecPath: '', nodeExecPath, platform: 'linux' })).toEqual({
      command: 'pnpm',
      prefixArgs: [],
      shell: false
    })
    expect(
      resolvePnpmCliInvocation({ npmExecPath: '', nodeExecPath, platform: 'win32', pnpmHome: '' })
    ).toEqual({
      command: 'pnpm.cmd',
      prefixArgs: [],
      shell: true
    })
  })

  // Both callers invoke the helper with no options, so the env default is the only path they take.
  it('reads npm_execpath from the environment when the option is omitted', () => {
    vi.stubEnv('npm_execpath', '/opt/pnpm/bin/pnpm.cjs')
    expect(resolvePnpmCliInvocation({ nodeExecPath, platform: 'darwin' })).toEqual({
      command: nodeExecPath,
      prefixArgs: ['/opt/pnpm/bin/pnpm.cjs'],
      shell: false
    })

    vi.stubEnv('npm_execpath', '/opt/pnpm/bin/pnpm')
    expect(resolvePnpmCliInvocation({ nodeExecPath, platform: 'darwin' })).toEqual({
      command: '/opt/pnpm/bin/pnpm',
      prefixArgs: [],
      shell: false
    })
  })

  it('falls back to PATH pnpm when npm_execpath is absent from the environment', () => {
    vi.stubEnv('npm_execpath', undefined)
    vi.stubEnv('PNPM_HOME', undefined)
    expect(resolvePnpmCliInvocation({ nodeExecPath, platform: 'darwin' })).toEqual({
      command: 'pnpm',
      prefixArgs: [],
      shell: false
    })
    expect(resolvePnpmCliInvocation({ nodeExecPath, platform: 'win32' })).toEqual({
      command: 'pnpm.cmd',
      prefixArgs: [],
      shell: true
    })
  })
  it('uses the flat native Windows install when exec supplies no npm_execpath', () => {
    vi.stubEnv('npm_execpath', undefined)
    vi.stubEnv('PNPM_HOME', 'C:\\Users\\Runner Admin\\setup-pnpm')
    const native = 'C:\\Users\\Runner Admin\\setup-pnpm\\pnpm.exe'
    const fileExists = vi.fn((path) => path === native)
    expect(resolvePnpmCliInvocation({ platform: 'win32', fileExists })).toEqual({
      command: native,
      prefixArgs: [],
      shell: false
    })
    expect(fileExists.mock.calls.map(([path]) => path)).toEqual([
      'C:\\Users\\Runner Admin\\setup-pnpm\\bin\\pnpm.exe',
      native
    ])
  })

  it('prefers the updated native bin entry over the original native install', () => {
    const native = 'C:\\pnpm\\bin\\pnpm.exe'
    const fileExists = vi.fn(() => true)
    expect(
      resolvePnpmCliInvocation({
        npmExecPath: '',
        platform: 'win32',
        pnpmHome: 'C:/pnpm',
        fileExists
      })
    ).toEqual({ command: native, prefixArgs: [], shell: false })
    expect(fileExists).toHaveBeenCalledExactlyOnceWith(native)
  })

  it.each([
    ['C:\\legacy\\pnpm.cjs', nodeExecPath, ['C:\\legacy\\pnpm.cjs'], false],
    ['C:\\legacy\\pnpm.CMD', 'C:\\legacy\\pnpm.CMD', [], true],
    ['C:\\legacy\\pnpm.exe', 'C:\\legacy\\pnpm.exe', [], false]
  ])('keeps explicit %s ahead of any native home fallback', (entry, command, prefixArgs, shell) => {
    const fileExists = vi.fn(() => true)
    expect(
      resolvePnpmCliInvocation({
        npmExecPath: entry,
        nodeExecPath,
        platform: 'win32',
        pnpmHome: 'C:\\pnpm',
        fileExists
      })
    ).toEqual({ command, prefixArgs, shell })
    expect(fileExists).not.toHaveBeenCalled()
  })

  it.each(['', 'pnpm', 'C:pnpm'])('does not probe the relative or empty home %s', (pnpmHome) => {
    const fileExists = vi.fn(() => true)
    expect(
      resolvePnpmCliInvocation({ npmExecPath: '', platform: 'win32', pnpmHome, fileExists })
    ).toEqual({ command: 'pnpm.cmd', prefixArgs: [], shell: true })
    expect(fileExists).not.toHaveBeenCalled()
  })

  it('keeps the batch fallback when the native home files are absent', () => {
    const fileExists = vi.fn(() => false)
    expect(
      resolvePnpmCliInvocation({
        npmExecPath: '',
        platform: 'win32',
        pnpmHome: 'C:\\pnpm',
        fileExists
      })
    ).toEqual({ command: 'pnpm.cmd', prefixArgs: [], shell: true })
    expect(fileExists).toHaveBeenCalledTimes(2)
  })

  it.each(['darwin', 'linux'])('does not use a Windows home lookup on %s', (platform) => {
    const fileExists = vi.fn(() => true)
    expect(
      resolvePnpmCliInvocation({ npmExecPath: '', platform, pnpmHome: 'C:\\pnpm', fileExists })
    ).toEqual({ command: 'pnpm', prefixArgs: [], shell: false })
    expect(fileExists).not.toHaveBeenCalled()
  })
})
