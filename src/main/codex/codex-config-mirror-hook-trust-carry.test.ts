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

import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import { parseTomlTableHeaderPath } from './config-toml-key-path'
import { getTomlSections } from './config-toml-runtime-owned-sections'
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
})
