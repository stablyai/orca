import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'

// Why: temp homes exceed sun_path on macOS but not on Linux; keep asserted config bytes host-independent.
vi.mock('./codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyCodexDaemonSocketGuard: (config: string) => config
}))

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: homedirMock
  }
})

import {
  syncSystemConfigIntoLegacySharedCodexHome,
  syncSystemConfigIntoManagedCodexHome
} from './codex-config-mirror'

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

function getSystemCodexHomePath(): string {
  return join(fakeHomeDir, '.codex')
}

function getSystemConfigPath(): string {
  return join(getSystemCodexHomePath(), 'config.toml')
}

function getRuntimeConfigPath(): string {
  return join(userDataDir, 'codex-runtime-home', 'home', 'config.toml')
}

beforeEach(() => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-config-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-config-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  mkdirSync(getSystemCodexHomePath(), { recursive: true })
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('managed-home mirror never writes a config Codex cannot read (#22592)', () => {
  it('collapses both project spellings and a doubled [hooks.state] in an existing managed home (#22592)', () => {
    writeFileSync(
      getSystemConfigPath(),
      'model = "m"\n\n["projects"."/repo"]\ntrust_level = "trusted"\n',
      'utf-8'
    )
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      [
        'model = "m"',
        '',
        '["projects"."/repo"]',
        'trust_level = "trusted"',
        '',
        '[projects."/repo"]',
        'trust_level = "trusted"',
        '',
        '[hooks.state]',
        '',
        '[hooks.state]',
        '',
        '[hooks.state."/rt/hooks.json:stop:0:0"]',
        'enabled = true',
        'trusted_hash = "sha256:x"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readFileSync(getRuntimeConfigPath(), 'utf-8')
    expect(parse(runtimeConfig)).toEqual({
      model: 'm',
      projects: { '/repo': { trust_level: 'trusted' } },
      hooks: { state: { '/rt/hooks.json:stop:0:0': { enabled: true, trusted_hash: 'sha256:x' } } }
    })
  })

  it('drops a runtime project table that ~/.codex defines inline', () => {
    writeFileSync(
      getSystemConfigPath(),
      '[projects]\n"/repo" = { trust_level = "untrusted" }\n',
      'utf-8'
    )
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(getRuntimeConfigPath(), '[projects."/repo"]\ntrust_level = "trusted"\n', 'utf-8')

    syncSystemConfigIntoManagedCodexHome()

    expect(parse(readFileSync(getRuntimeConfigPath(), 'utf-8'))).toEqual({
      projects: { '/repo': { trust_level: 'untrusted' } }
    })
  })

  it('keeps managed trust for a project ~/.codex defines only through a sub-table', () => {
    writeFileSync(
      getSystemConfigPath(),
      'model = "m"\n\n[projects."/repo".extra]\nx = 1\n',
      'utf-8'
    )
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      'model = "m"\n\n[projects."/repo".extra]\nx = 1\n\n[projects."/repo"]\ntrust_level = "trusted"\n',
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(parse(readFileSync(getRuntimeConfigPath(), 'utf-8'))).toEqual({
      model: 'm',
      projects: { '/repo': { extra: { x: 1 }, trust_level: 'trusted' } }
    })
  })

  it.each([
    ['dotted keys under [projects]', '[projects]\n"/repo".trust_level = "untrusted"\n'],
    ['root dotted keys', 'projects."/repo".trust_level = "untrusted"\n']
  ])(
    'drops managed trust for a project ~/.codex defines through a sub-table and %s',
    (_placement, dotted) => {
      const systemConfig = `model = "m"\n${dotted}\n[projects."/repo".extra]\nx = 1\n`
      writeFileSync(getSystemConfigPath(), systemConfig, 'utf-8')
      mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
      writeFileSync(
        getRuntimeConfigPath(),
        'model = "m"\n\n[projects."/repo"]\ntrust_level = "trusted"\n',
        'utf-8'
      )

      syncSystemConfigIntoManagedCodexHome()

      expect(parse(readFileSync(getRuntimeConfigPath(), 'utf-8'))).toEqual({
        model: 'm',
        projects: { '/repo': { trust_level: 'untrusted', extra: { x: 1 } } }
      })
    }
  )

  it.each([
    ['[projects]', '[projects]\n"/repo".extra.q = 1\n'],
    ['the root', 'projects."/repo".extra.q = 1\n']
  ])(
    'drops managed trust when a dotted key under %s creates the parent of a deeper sub-table',
    (_placement, dotted) => {
      writeFileSync(
        getSystemConfigPath(),
        `model = "m"\n${dotted}\n[projects."/repo".extra.deep]\nz = 1\n`,
        'utf-8'
      )
      mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
      writeFileSync(
        getRuntimeConfigPath(),
        'model = "m"\n\n[projects."/repo"]\ntrust_level = "trusted"\n',
        'utf-8'
      )

      syncSystemConfigIntoManagedCodexHome()

      expect(parse(readFileSync(getRuntimeConfigPath(), 'utf-8'))).toEqual({
        model: 'm',
        projects: { '/repo': { extra: { q: 1, deep: { z: 1 } } } }
      })
    }
  )

  it('keeps managed trust for a project ~/.codex defines only through a deeper sub-table', () => {
    writeFileSync(
      getSystemConfigPath(),
      'model = "m"\n\n[projects."/repo".extra.deep]\nz = 1\n',
      'utf-8'
    )
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    writeFileSync(
      getRuntimeConfigPath(),
      'model = "m"\n\n[projects."/repo"]\ntrust_level = "trusted"\n',
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(parse(readFileSync(getRuntimeConfigPath(), 'utf-8'))).toEqual({
      model: 'm',
      projects: { '/repo': { extra: { deep: { z: 1 } }, trust_level: 'trusted' } }
    })
  })

  it('collapses Orca\u2019s own duplicate hook tables, so managed-only trust survives', () => {
    writeFileSync(getSystemConfigPath(), 'model = "m"\n', 'utf-8')
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    const key = '/rt/hooks.json:stop:0:0'
    writeFileSync(
      getRuntimeConfigPath(),
      [
        'model = "m"',
        '',
        '[projects."/answered-in-orca"]',
        'trust_level = "trusted"',
        '',
        `[hooks.state."${key}"]`,
        'trusted_hash = "sha256:a"',
        '',
        `[hooks.state."${key}"]`,
        'trusted_hash = "sha256:b"',
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(parse(readFileSync(getRuntimeConfigPath(), 'utf-8'))).toEqual({
      model: 'm',
      projects: { '/answered-in-orca': { trust_level: 'trusted' } },
      hooks: { state: { [key]: { trusted_hash: 'sha256:a' } } }
    })
  })
})

// Why: handling a ~/.codex the user broke by hand is a separate change; until
// then the mirrors must do exactly what they did before the checked writer.
describe('a ~/.codex the user broke by hand is mirrored as before', () => {
  const brokenSource = 'model = "A"\n\n[mcp_servers.keep]\ncommand = "k"\nbroken = \n'
  const managedOnly =
    '\n[mcp_servers.mine]\ncommand = "m"\n\n[projects."/sub"]\ntrust_level = "trusted"\n'
  const managed = `model = "A"\n\n[mcp_servers.keep]\ncommand = "k"\n${managedOnly}`

  function makeHomes(): { systemHomePath: string; runtimeHomePath: string } {
    const homes = {
      systemHomePath: join(fakeHomeDir, 'sys'),
      runtimeHomePath: join(fakeHomeDir, 'rt')
    }
    mkdirSync(homes.systemHomePath, { recursive: true })
    mkdirSync(homes.runtimeHomePath, { recursive: true })
    writeFileSync(join(homes.systemHomePath, 'config.toml'), brokenSource)
    return homes
  }

  it.each([
    [
      'managed home',
      syncSystemConfigIntoManagedCodexHome,
      `model = "A"\n\n[mcp_servers.keep]\ncommand = "k"\nbroken =\n${managedOnly}`
    ],
    [
      'legacy shared home',
      syncSystemConfigIntoLegacySharedCodexHome,
      'model = "A"\n\n[mcp_servers.keep]\ncommand = "k"\nbroken =\n\n[projects."/sub"]\ntrust_level = "trusted"\n'
    ]
  ])('merges it into a %s holding managed-only state', (_label, sync, expected) => {
    const homes = makeHomes()
    const rtPath = join(homes.runtimeHomePath, 'config.toml')
    writeFileSync(rtPath, managed)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    sync(homes)
    sync(homes)

    expect(readFileSync(rtPath, 'utf8')).toBe(expected)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it.each([
    ['managed home', syncSystemConfigIntoManagedCodexHome],
    ['legacy shared home', syncSystemConfigIntoLegacySharedCodexHome]
  ])('seeds a fresh %s from it', (_label, sync) => {
    const homes = makeHomes()

    sync(homes)

    expect(readFileSync(join(homes.runtimeHomePath, 'config.toml'), 'utf8')).toBe(
      'model = "A"\n\n[mcp_servers.keep]\ncommand = "k"\nbroken =\n'
    )
  })

  it('holds an in-Codex change back until ~/.codex parses, then promotes it', () => {
    const homes = makeHomes()
    const sysPath = join(homes.systemHomePath, 'config.toml')
    const rtPath = join(homes.runtimeHomePath, 'config.toml')
    const good = 'model = "A"\n\n[mcp_servers.keep]\ncommand = "k"\n'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      writeFileSync(sysPath, good)
      syncSystemConfigIntoManagedCodexHome(homes)
      // Codex inside Orca: /model B and a trust answer; then the user breaks ~/.codex.
      writeFileSync(
        rtPath,
        `${readFileSync(rtPath, 'utf8').replace('model = "A"', 'model = "B"')}${managedOnly}`
      )
      const runtimeBeforeBreak = readFileSync(rtPath, 'utf8')
      writeFileSync(sysPath, brokenSource)
      syncSystemConfigIntoManagedCodexHome(homes)
      syncSystemConfigIntoManagedCodexHome(homes)

      expect(readFileSync(sysPath, 'utf8')).toBe(brokenSource)
      expect(readFileSync(rtPath, 'utf8')).toBe(runtimeBeforeBreak)
      expect(
        warn.mock.calls.flat().filter((line) => String(line).includes('Skipped promoting'))
      ).toHaveLength(1)

      writeFileSync(sysPath, good)
      syncSystemConfigIntoManagedCodexHome(homes)
      expect(parse(readFileSync(sysPath, 'utf8')).model).toBe('B')
      expect(parse(readFileSync(rtPath, 'utf8'))).toMatchObject({
        model: 'B',
        mcp_servers: { mine: { command: 'm' } },
        projects: { '/sub': { trust_level: 'trusted' } }
      })
    } finally {
      warn.mockRestore()
    }
  })
})
