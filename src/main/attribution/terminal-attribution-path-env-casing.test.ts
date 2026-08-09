import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyTerminalAttributionEnv } from './terminal-attribution'

describe('applyTerminalAttributionEnv PATH key casing', () => {
  let tmpRoot: string | null = null

  afterEach(() => {
    if (tmpRoot) {
      rmSync(tmpRoot, { force: true, recursive: true })
      tmpRoot = null
    }
  })

  function makeTmpRoot(): string {
    tmpRoot = mkdtempSync(join(tmpdir(), 'orca-attribution-path-casing-'))
    return tmpRoot
  }

  // Why: a Windows child that inherits both spellings crashes the packaged orca.exe launcher
  // with "Item has already been added. Key in dictionary: 'PATH'" (stablyai/orca#12046).
  function pathEnvKeys(env: Record<string, string>): string[] {
    return Object.keys(env).filter((key) => /^path$/i.test(key))
  }

  it('writes back the inherited Windows `Path` spelling instead of adding `PATH`', () => {
    const root = makeTmpRoot()
    const userDataPath = join(root, 'user-data')
    const baseEnv: Record<string, string> = {
      Path: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd',
      SystemRoot: 'C:\\Windows'
    }

    applyTerminalAttributionEnv(baseEnv, {
      enabled: true,
      platform: 'win32',
      shellFamily: 'native-windows',
      userDataPath
    })

    const win32Dir = join(userDataPath, 'orca-terminal-attribution', 'win32')
    const pathEntries = baseEnv.Path.split(';')

    expect(pathEnvKeys(baseEnv)).toEqual(['Path'])
    expect(pathEntries[0]).toBe(win32Dir)
    expect(pathEntries).toContain('C:\\Program Files\\Git\\cmd')
  })

  // Why: Win32 resolves a duplicated variable by taking the first match in the block, so the
  // shim must land on the first-listed spelling and the shadowed one must keep its value —
  // dropping it would promote it the moment anything downstream removes the live key.
  it.each([
    { first: 'PATH', second: 'Path' },
    { first: 'Path', second: 'PATH' }
  ])(
    'prepends the shim onto the first-listed `$first` and leaves `$second` untouched',
    ({ first, second }) => {
      const root = makeTmpRoot()
      const userDataPath = join(root, 'user-data')
      const baseEnv: Record<string, string> = {
        [first]: 'C:\\tools\\bin;C:\\Windows\\system32',
        [second]: 'C:\\Windows\\system32'
      }

      applyTerminalAttributionEnv(baseEnv, {
        enabled: true,
        platform: 'win32',
        shellFamily: 'native-windows',
        userDataPath
      })

      const win32Dir = join(userDataPath, 'orca-terminal-attribution', 'win32')
      expect(baseEnv[first].split(';')).toEqual([
        win32Dir,
        'C:\\tools\\bin',
        'C:\\Windows\\system32'
      ])
      expect(baseEnv[second]).toBe('C:\\Windows\\system32')
    }
  )

  it('keeps a shadowed duplicate when the live spelling strips down to nothing', () => {
    const root = makeTmpRoot()
    const userDataPath = join(root, 'user-data')
    const shimDir = join(userDataPath, 'orca-terminal-attribution', 'win32')
    const baseEnv: Record<string, string> = { Path: shimDir, PATH: 'C:\\Windows\\system32' }

    applyTerminalAttributionEnv(baseEnv, {
      enabled: false,
      platform: 'win32',
      shellFamily: 'native-windows',
      userDataPath
    })

    expect(pathEnvKeys(baseEnv)).toEqual(['PATH'])
    expect(baseEnv.PATH).toBe('C:\\Windows\\system32')
  })

  it('strips shim entries from the inherited `Path` when attribution is disabled', () => {
    const root = makeTmpRoot()
    const userDataPath = join(root, 'user-data')
    const shimDir = join(userDataPath, 'orca-terminal-attribution', 'win32')
    const baseEnv: Record<string, string> = { Path: `${shimDir};C:\\Windows\\system32` }

    applyTerminalAttributionEnv(baseEnv, {
      enabled: false,
      platform: 'win32',
      shellFamily: 'native-windows',
      userDataPath
    })

    expect(pathEnvKeys(baseEnv)).toEqual(['Path'])
    expect(baseEnv.Path).toBe('C:\\Windows\\system32')
  })

  // Why: the daemon receives a sparse env patch with no path key and re-merges its own block
  // underneath it, so guessing the spelling here hands the child both.
  it.each([
    { hostKey: 'PATH', otherKey: 'Path' },
    { hostKey: 'Path', otherKey: 'PATH' }
  ])('adopts a host block spelt `$hostKey` on a path-less env', ({ hostKey, otherKey }) => {
    const root = makeTmpRoot()
    const userDataPath = join(root, 'user-data')
    const inherited = { PATH: process.env.PATH, Path: process.env.Path }
    delete process.env.PATH
    delete process.env.Path
    process.env[hostKey] = 'C:\\Windows\\system32'

    try {
      const baseEnv: Record<string, string> = { SystemRoot: 'C:\\Windows' }

      applyTerminalAttributionEnv(baseEnv, {
        enabled: true,
        platform: 'win32',
        shellFamily: 'native-windows',
        userDataPath
      })

      expect(pathEnvKeys(baseEnv)).toEqual([hostKey])
      expect(baseEnv[otherKey]).toBeUndefined()
    } finally {
      delete process.env[hostKey]
      for (const [key, value] of Object.entries(inherited)) {
        if (value !== undefined) {
          process.env[key] = value
        }
      }
    }
  })

  it('leaves a case-sensitive POSIX `Path` variable alone', () => {
    const root = makeTmpRoot()
    const baseEnv: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      Path: '/decoy'
    }

    applyTerminalAttributionEnv(baseEnv, {
      enabled: true,
      platform: 'linux',
      userDataPath: join(root, 'user-data')
    })

    expect(baseEnv.Path).toBe('/decoy')
    expect(baseEnv.PATH.split(':')).toContain('/usr/bin')
  })
})
