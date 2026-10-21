import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'

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
  prepareSystemConfigForFreshRuntimeMirror,
  syncSystemConfigIntoManagedCodexHome
} from './codex-config-mirror'
import { parseTomlTableHeaderPath } from './config-toml-key-path'
import { extractOrdinaryCodexSettings, getTomlSections } from './config-toml-runtime-owned-sections'
import { escapeTomlString } from './config-toml-trust'

const PLUGIN_KEY = 'demo@mkt:hooks/hooks.json:stop:0:0'
const PROJECT_KEY = '/repo/.codex/hooks.json:stop:0:0'

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

function systemCodexHome(): string {
  return join(fakeHomeDir, '.codex')
}

function runtimeConfigPath(): string {
  return join(userDataDir, 'codex-runtime-home', 'home', 'config.toml')
}

function bareParent(key: string): string {
  return `[hooks.state."${escapeTomlString(key)}"]`
}

function fullyQuoted(key: string): string {
  return `["hooks"."state"."${escapeTomlString(key)}"]`
}

function trustBlock(header: string, hash: string, enabled = true): string {
  return [header, `enabled = ${enabled}`, `trusted_hash = "${hash}"`].join('\n')
}

function writeSystemConfig(blocks: string[]): void {
  writeFileSync(
    join(systemCodexHome(), 'config.toml'),
    `${['model = "system-model"', ...blocks].join('\n\n')}\n`,
    'utf-8'
  )
}

function writeRuntimeConfig(blocks: string[]): void {
  mkdirSync(join(userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
  writeFileSync(runtimeConfigPath(), `${['model = "runtime-model"', ...blocks].join('\n\n')}\n`)
}

function mirror(): string {
  syncSystemConfigIntoManagedCodexHome()
  return readFileSync(runtimeConfigPath(), 'utf-8')
}

// Why: Codex refuses a file that declares one table twice under any spelling (#22592).
function expectNoDuplicateTables(toml: string): void {
  const tables = getTomlSections(toml).flatMap((section) => {
    const table = parseTomlTableHeaderPath(section.header)
    return table && !table.isArray ? [JSON.stringify(table.segments)] : []
  })
  expect(new Set(tables).size).toBe(tables.length)
}

function countHookTrustTables(toml: string, key: string): number {
  return getTomlSections(toml).filter((section) => {
    const table = parseTomlTableHeaderPath(section.header)
    return table?.segments.length === 3 && table.segments[2] === key
  }).length
}

beforeEach(() => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-trust-carry-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-trust-carry-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  mkdirSync(systemCodexHome(), { recursive: true })
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

describe('carrying plain-Codex hook trust into the managed Codex home', () => {
  it.each([
    ['plugin', 'bare parent', PLUGIN_KEY, bareParent],
    ['plugin', 'fully quoted', PLUGIN_KEY, fullyQuoted],
    ['project', 'bare parent', PROJECT_KEY, bareParent],
    ['project', 'fully quoted', PROJECT_KEY, fullyQuoted]
  ])(
    'carries %s hook trust in the %s spelling into a fresh home',
    (_kind, _spelling, key, spell) => {
      const block = trustBlock(spell(key), 'sha256:plain-codex')
      writeSystemConfig([block])

      const runtimeConfig = mirror()

      expect(runtimeConfig).toContain(block)
      expectNoDuplicateTables(runtimeConfig)
    }
  )

  // Why: Codex >=0.145 adds session_end and >=0.150 interrupt, which Orca's own parser rejects.
  it.each(
    ['session_end', 'interrupt'].flatMap((event) =>
      [
        ['plugin', `demo@mkt:hooks/hooks.json:${event}:0:0`],
        ['project', `/repo/.codex/hooks.json:${event}:0:0`]
      ].flatMap(([kind, key]) => [
        [event, kind, 'bare parent', key, bareParent] as const,
        [event, kind, 'fully quoted', key, fullyQuoted] as const
      ])
    )
  )('carries %s %s hook trust in the %s spelling', (_event, _kind, _spelling, key, spell) => {
    const block = trustBlock(spell(key), 'sha256:newer-event')
    writeSystemConfig([block])

    mirror()
    const runtimeConfig = mirror()

    expect(runtimeConfig).toContain(block)
    expect(countHookTrustTables(runtimeConfig, key)).toBe(1)
    expectNoDuplicateTables(runtimeConfig)
  })

  it.each(['session_end', 'interrupt'])('leaves out user-layer %s trust', (event) => {
    const key = `${join(systemCodexHome(), 'hooks.json')}:${event}:0:0`
    writeSystemConfig([trustBlock(fullyQuoted(key), 'sha256:user-hook')])

    expect(mirror()).not.toContain('sha256:user-hook')
  })

  it.each([
    'not-a-hook-key',
    '/repo/.codex/hooks.json:stop:0',
    '/repo/.codex/hooks.json:stop:01:0',
    '/repo/.codex/hooks.json:Stop:0:0',
    ':stop:0:0'
  ])('does not carry the unattributable key %s', (key) => {
    writeSystemConfig([
      trustBlock(bareParent(key), 'sha256:unattributable'),
      trustBlock(fullyQuoted(PLUGIN_KEY), 'sha256:plugin')
    ])

    const runtimeConfig = mirror()

    expect(runtimeConfig).toContain('sha256:plugin')
    expect(runtimeConfig).not.toContain('sha256:unattributable')
  })

  it.each([
    ['hooks.json', bareParent],
    ['hooks.json', fullyQuoted],
    ['config.toml', bareParent],
    ['config.toml', fullyQuoted]
  ])('leaves out user-layer trust keyed by ~/.codex/%s', (file, spell) => {
    const logicalKey = `${join(systemCodexHome(), file)}:stop:0:0`
    const realKey = `${join(realpathSync.native(systemCodexHome()), file)}:stop:1:0`
    writeSystemConfig([
      trustBlock(spell(logicalKey), 'sha256:user-hook'),
      trustBlock(spell(realKey), 'sha256:user-hook-realpath')
    ])

    const runtimeConfig = mirror()

    expect(runtimeConfig).toContain('model = "system-model"')
    expect(runtimeConfig).not.toContain('sha256:user-hook')
  })

  it.each([
    ['fully quoted', fullyQuoted],
    ['bare parent', bareParent]
  ])('keeps one %s shared table across repeated launches', (_spelling, spell) => {
    const block = trustBlock(spell(PLUGIN_KEY), 'sha256:plain-codex')
    writeSystemConfig([block])

    mirror()
    const secondLaunch = mirror()
    const thirdLaunch = mirror()

    expect(thirdLaunch).toBe(secondLaunch)
    expect(countHookTrustTables(thirdLaunch, PLUGIN_KEY)).toBe(1)
    expect(thirdLaunch).toContain(block)
    expectNoDuplicateTables(thirdLaunch)
  })

  it.each([
    ['bare parent', 'fully quoted', bareParent, fullyQuoted],
    ['fully quoted', 'bare parent', fullyQuoted, bareParent]
  ])(
    'keeps the runtime %s copy over a system %s copy of the same key',
    (_runtimeSpelling, _systemSpelling, runtimeSpell, systemSpell) => {
      const runtimeBlock = trustBlock(runtimeSpell(PROJECT_KEY), 'sha256:approved-in-orca')
      writeRuntimeConfig([runtimeBlock])
      writeSystemConfig([trustBlock(systemSpell(PROJECT_KEY), 'sha256:plain-codex')])

      const runtimeConfig = mirror()

      expect(runtimeConfig).toContain(runtimeBlock)
      expect(runtimeConfig).not.toContain('sha256:plain-codex')
      expect(countHookTrustTables(runtimeConfig, PROJECT_KEY)).toBe(1)
      expectNoDuplicateTables(runtimeConfig)
    }
  )

  it('carries a shared key only once when ~/.codex already repeats it', () => {
    writeSystemConfig([
      trustBlock(bareParent(PLUGIN_KEY), 'sha256:first'),
      trustBlock(fullyQuoted(PLUGIN_KEY), 'sha256:second')
    ])

    const runtimeConfig = mirror()

    expect(countHookTrustTables(runtimeConfig, PLUGIN_KEY)).toBe(1)
    expect(runtimeConfig).toContain('sha256:first')
    expectNoDuplicateTables(runtimeConfig)
  })

  it('treats basic and literal spellings of a Windows key as one table', () => {
    const windowsKey = 'C:\\r\\.codex\\hooks.json:stop:0:0'
    const runtimeBlock = trustBlock(`[hooks.state.'${windowsKey}']`, 'sha256:runtime')
    writeRuntimeConfig(['[hooks.state]', runtimeBlock])
    writeSystemConfig([
      '["hooks"."state"]',
      trustBlock(fullyQuoted(windowsKey), 'sha256:system-same-key'),
      trustBlock(bareParent('C:/r/.codex/hooks.json:stop:0:0'), 'sha256:system-slash-variant')
    ])

    const runtimeConfig = mirror()

    expect(runtimeConfig).toContain(runtimeBlock)
    expect(runtimeConfig).not.toContain('sha256:system-same-key')
    // Why: Codex 0.140 reads the other slash variant, which is a distinct table.
    expect(runtimeConfig).toContain('sha256:system-slash-variant')
    expect(countHookTrustTables(runtimeConfig, windowsKey)).toBe(1)
    expectNoDuplicateTables(runtimeConfig)
  })

  it.each([
    ['[hooks.state]', '["hooks"."state"]'],
    ['["hooks"."state"]', '[hooks.state]']
  ])('keeps only the runtime %s parent table over the system %s', (runtimeParent, systemParent) => {
    writeRuntimeConfig([`${runtimeParent}\n# runtime parent`])
    writeSystemConfig([
      `${systemParent}\n# system parent`,
      trustBlock(bareParent(PLUGIN_KEY), 'sha256:plain-codex')
    ])

    const runtimeConfig = mirror()

    expect(runtimeConfig).toContain('# runtime parent')
    expect(runtimeConfig).not.toContain('# system parent')
    expect(runtimeConfig).toContain('sha256:plain-codex')
    expectNoDuplicateTables(runtimeConfig)
  })

  it('carries shared trust when seeding a WSL home from its Linux-side path', () => {
    const prepared = prepareSystemConfigForFreshRuntimeMirror(
      [
        trustBlock(fullyQuoted('/home/alice/.codex/hooks.json:stop:0:0'), 'sha256:user'),
        trustBlock(fullyQuoted('/home/alice/repo/.codex/hooks.json:stop:0:0'), 'sha256:project')
      ].join('\n\n'),
      '/home/alice/.codex'
    )

    expect(prepared).not.toContain('sha256:user')
    expect(prepared).toContain('sha256:project')
  })

  it('never promotes runtime hook trust into ~/.codex settings', () => {
    const ordinary = extractOrdinaryCodexSettings(
      [
        'model = "runtime-model"',
        trustBlock(bareParent(PLUGIN_KEY), 'sha256:plugin'),
        trustBlock(fullyQuoted(PROJECT_KEY), 'sha256:project')
      ].join('\n\n')
    )

    expect(ordinary).toBe('model = "runtime-model"')
  })
})
