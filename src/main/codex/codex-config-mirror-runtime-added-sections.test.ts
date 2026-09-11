import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'

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

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

function getSystemConfigPath(): string {
  return join(fakeHomeDir, '.codex', 'config.toml')
}

function getRuntimeHomePath(): string {
  return join(userDataDir, 'codex-runtime-home', 'home')
}

function getRuntimeConfigPath(): string {
  return join(getRuntimeHomePath(), 'config.toml')
}

function readRuntimeConfig(): string {
  return readFileSync(getRuntimeConfigPath(), 'utf-8')
}

function readBaselineSections(runtimeHomePath = getRuntimeHomePath()): unknown {
  const raw = readFileSync(join(runtimeHomePath, '.orca-config-settings-baseline.json'), 'utf-8')
  return (JSON.parse(raw) as { mirroredSections?: unknown }).mirroredSections
}

function writeSystemConfig(...lines: string[]): void {
  writeFileSync(getSystemConfigPath(), `${lines.join('\n')}\n`, 'utf-8')
}

/** Stands in for `codex mcp add` run inside an Orca-launched Codex: the table
 *  exists only in the managed home, never in the user's ~/.codex. */
function addServerInsideManagedHome(...lines: string[]): void {
  appendFileSync(getRuntimeConfigPath(), `\n${lines.join('\n')}\n`, 'utf-8')
}

beforeEach(() => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-added-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-added-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  mkdirSync(join(fakeHomeDir, '.codex'), { recursive: true })
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

describe('a config section added inside the managed Codex home', () => {
  it('survives the next remirror', () => {
    writeSystemConfig('model = "system-model"', '', '[mcp_servers.serena]', 'command = "serena"')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[mcp_servers.added-in-orca]', 'command = "added"')

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readRuntimeConfig()
    expect(runtimeConfig).toContain('[mcp_servers.added-in-orca]')
    expect(runtimeConfig).toContain('command = "added"')
    // Why: the source's own server must still arrive; preservation is additive.
    expect(runtimeConfig).toContain('[mcp_servers.serena]')
  })

  it('survives repeated remirrors rather than only the first', () => {
    writeSystemConfig('model = "system-model"', '', '[mcp_servers.serena]', 'command = "serena"')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[mcp_servers.added-in-orca]', 'command = "added"')

    syncSystemConfigIntoManagedCodexHome()
    syncSystemConfigIntoManagedCodexHome()
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('[mcp_servers.added-in-orca]')
  })

  it('is byte-identical across repeated remirrors', () => {
    writeSystemConfig('model = "system-model"', '', '[mcp_servers.serena]', 'command = "serena"')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[mcp_servers.added-in-orca]', 'command = "added"')

    syncSystemConfigIntoManagedCodexHome()
    const afterFirst = readRuntimeConfig()
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toBe(afterFirst)
  })

  it('keeps its nested env and http_headers tables with the server they belong to', () => {
    writeSystemConfig('model = "system-model"')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome(
      '[mcp_servers.added-in-orca]',
      'command = "added"',
      '',
      '[mcp_servers.added-in-orca.env]',
      'TOKEN = "value"',
      '',
      '[mcp_servers.added-in-orca.http_headers]',
      'Authorization = "Bearer token"'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readRuntimeConfig()
    expect(runtimeConfig).toContain('TOKEN = "value"')
    expect(runtimeConfig).toContain('Authorization = "Bearer token"')
    // Why: a nested table is only attached to its parent while it still follows
    // it, so preserving the blocks out of order would silently reparent them.
    expect(runtimeConfig.indexOf('[mcp_servers.added-in-orca]')).toBeLessThan(
      runtimeConfig.indexOf('[mcp_servers.added-in-orca.env]')
    )
    expect(runtimeConfig.indexOf('[mcp_servers.added-in-orca.env]')).toBeLessThan(
      runtimeConfig.indexOf('[mcp_servers.added-in-orca.http_headers]')
    )
  })

  it('keeps more than one added server', () => {
    writeSystemConfig('model = "system-model"')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome(
      '[mcp_servers.first-added]',
      'command = "first"',
      '',
      '[mcp_servers.second-added]',
      'command = "second"'
    )

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('[mcp_servers.first-added]')
    expect(readRuntimeConfig()).toContain('[mcp_servers.second-added]')
  })

  it('records what the source contributed so a later pass can tell the two apart', () => {
    writeSystemConfig('model = "system-model"', '', '[mcp_servers.serena]', 'command = "serena"')

    syncSystemConfigIntoManagedCodexHome()

    expect(readBaselineSections()).toEqual(['["mcp_servers","serena"]'])
  })
})

describe('ownership between the source config and the managed home', () => {
  it('lets the source win for a server name defined on both sides', () => {
    writeSystemConfig('model = "system-model"', '', '[mcp_servers.shared]', 'command = "system"')
    syncSystemConfigIntoManagedCodexHome()
    writeFileSync(
      getRuntimeConfigPath(),
      ['model = "system-model"', '', '[mcp_servers.shared]', 'command = "runtime"', ''].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoManagedCodexHome()

    const runtimeConfig = readRuntimeConfig()
    expect(runtimeConfig).toContain('command = "system"')
    expect(runtimeConfig).not.toContain('command = "runtime"')
  })

  it('does not resurrect a server the user deleted from the source config', () => {
    writeSystemConfig(
      'model = "system-model"',
      '',
      '[mcp_servers.serena]',
      'command = "serena"',
      '',
      '[mcp_servers.retired]',
      'command = "retired"'
    )
    syncSystemConfigIntoManagedCodexHome()
    expect(readRuntimeConfig()).toContain('[mcp_servers.retired]')

    writeSystemConfig('model = "system-model"', '', '[mcp_servers.serena]', 'command = "serena"')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).not.toContain('[mcp_servers.retired]')
    expect(readRuntimeConfig()).toContain('[mcp_servers.serena]')
  })

  it('keeps an added server through the same pass that honours a deletion', () => {
    writeSystemConfig('model = "system-model"', '', '[mcp_servers.retired]', 'command = "retired"')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[mcp_servers.added-in-orca]', 'command = "added"')

    writeSystemConfig('model = "system-model"')
    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).not.toContain('[mcp_servers.retired]')
    expect(readRuntimeConfig()).toContain('[mcp_servers.added-in-orca]')
  })

  it('keeps an unrecognised runtime section when no record of the source exists', () => {
    // Why: a home mirrored by an older Orca has no recorded section set. The
    // managed home is the only copy of anything added inside it, so an
    // unanswered question must not authorize a deletion.
    writeSystemConfig('model = "system-model"')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[mcp_servers.added-in-orca]', 'command = "added"')
    rmSync(join(getRuntimeHomePath(), '.orca-config-settings-baseline.json'), { force: true })

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('[mcp_servers.added-in-orca]')
  })

  it('lets an inline table in the source out-rank the same table in the managed home', () => {
    // Why: TOML spells one table two ways. `tui = { .. }` in the source claims
    // `[tui]`, or the runtime's header form would look runtime-added and stick.
    writeSystemConfig('model = "system-model"', 'tui = { animations = false }')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[tui]', 'theme = "runtime-only"')

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).not.toContain('theme = "runtime-only"')
  })
})

describe('a per-account managed home passed explicitly', () => {
  it('follows the same ownership rules as the default host home', () => {
    // Why: WSL and per-account homes reach the mirror through these explicit
    // paths rather than the host defaults, and must not diverge from them.
    const accountHome = join(userDataDir, 'codex-accounts', 'account-1', 'home')
    mkdirSync(accountHome, { recursive: true })
    const homes = {
      runtimeHomePath: accountHome,
      systemHomePath: join(fakeHomeDir, '.codex')
    }
    writeSystemConfig('model = "system-model"', '', '[mcp_servers.retired]', 'command = "retired"')
    syncSystemConfigIntoManagedCodexHome(homes)
    appendFileSync(
      join(accountHome, 'config.toml'),
      '\n[mcp_servers.added-in-orca]\ncommand = "added"\n',
      'utf-8'
    )

    writeSystemConfig('model = "system-model"')
    syncSystemConfigIntoManagedCodexHome(homes)

    const accountConfig = readFileSync(join(accountHome, 'config.toml'), 'utf-8')
    expect(accountConfig).toContain('[mcp_servers.added-in-orca]')
    expect(accountConfig).not.toContain('[mcp_servers.retired]')
    expect(readBaselineSections(accountHome)).toEqual([])
  })
})

describe('one table, however the two sides spell it', () => {
  // Why these are their own describe: before canonical keys a spelling
  // difference read as "the source does not declare this", so the mirror
  // emitted BOTH spellings. A duplicate table is an unparseable config.toml —
  // a worse outcome than the setting loss this change exists to fix, so each
  // spelling is pinned separately rather than trusted to one representative.
  function expectSingleServerTable(runtimeConfig: string): void {
    const declarations = runtimeConfig.match(/^\s*\[\[?[^\]]*serena[^\]]*\]\]?/gm) ?? []
    expect(declarations).toHaveLength(1)
  }

  it('treats a whitespace-padded source header as the same table', () => {
    writeSystemConfig('[ mcp_servers.serena ]', 'command = "serena"')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[mcp_servers.serena]', 'command = "runtime"')

    syncSystemConfigIntoManagedCodexHome()

    expectSingleServerTable(readRuntimeConfig())
    expect(readRuntimeConfig()).toContain('command = "serena"')
  })

  it('treats a quoted source key as the same table as a bare one', () => {
    writeSystemConfig('[mcp_servers."serena"]', 'command = "serena"')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[mcp_servers.serena]', 'command = "runtime"')

    syncSystemConfigIntoManagedCodexHome()

    expectSingleServerTable(readRuntimeConfig())
  })

  it('treats an array-of-tables name as claimed by a plain source table', () => {
    // Why: a table and an array of tables cannot share a name, so emitting both
    // is the same fatal shape as a duplicate.
    writeSystemConfig('[profiles]', 'x = 1')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[[profiles]]', 'x = 2')

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig().match(/^\s*\[\[?profiles\]\]?/gm) ?? []).toHaveLength(1)
  })

  it('lets a dotted source key claim the whole table path it declares', () => {
    writeSystemConfig('mcp_servers.foo.command = "x"')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[mcp_servers.foo]', 'command = "runtime"')

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).not.toContain('[mcp_servers.foo]')
  })

  it('does not extend a source inline table with a runtime sub-table', () => {
    // Why: TOML forbids it outright, so emitting the sub-table would produce a
    // config Codex refuses rather than a merge the user wanted.
    writeSystemConfig('mcp_servers = { foo = { command = "x" } }')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[mcp_servers.foo.env]', 'TOKEN = "value"')

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).not.toContain('[mcp_servers.foo.env]')
  })
})

describe('a table the source declares without a [header]', () => {
  // Why a second describe: the spelling cases above are all header-vs-header.
  // These are the other declaration sites — a dotted key, an inline table, and
  // a plain value — each of which binds a name a runtime header would then
  // redefine. Same unparseable-config outcome, reached a different way, so
  // each site is pinned rather than trusted to a representative.
  it('claims a table a dotted key declares inside a body', () => {
    writeSystemConfig('[mcp_servers]', 'serena.command = "serena"')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[mcp_servers.serena]', 'command = "runtime"')

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).not.toContain('[mcp_servers.serena]')
  })

  it('claims a table an inline value declares inside a body', () => {
    writeSystemConfig('[mcp_servers]', 'serena = { command = "serena" }')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[mcp_servers.serena]', 'command = "runtime"')

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).not.toContain('[mcp_servers.serena]')
  })

  it('claims a name a plain scalar already binds', () => {
    // Why a scalar counts: `model = "x"` leaves no table for `[model]` to add
    // to, so emitting the header is a redefinition, not a merge.
    writeSystemConfig('model = "system-model"')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[model]', 'nested = true')

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).not.toContain('[model]')
    expect(readRuntimeConfig()).toContain('model = "system-model"')
  })

  it('claims a name an array value already binds', () => {
    writeSystemConfig('model = "system-model"', 'items = [1, 2]')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[items]', 'nested = true')

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).not.toContain('[items]')
  })

  it('claims a nested name a scalar inside a body binds', () => {
    writeSystemConfig('[mcp_servers]', 'serena = "shorthand"')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[mcp_servers.serena]', 'command = "runtime"')

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).not.toContain('[mcp_servers.serena]')
  })

  it('still keeps a table the source only mentions as a bare header', () => {
    // Why paired here: every rule above deletes, so one case has to prove the
    // scan did not simply start dropping whatever it is shown.
    writeSystemConfig('[mcp_servers]')
    syncSystemConfigIntoManagedCodexHome()
    addServerInsideManagedHome('[mcp_servers.added-in-orca]', 'command = "added"')

    syncSystemConfigIntoManagedCodexHome()

    expect(readRuntimeConfig()).toContain('[mcp_servers.added-in-orca]')
  })
})

