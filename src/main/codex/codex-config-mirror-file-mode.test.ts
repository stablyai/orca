import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})

import {
  syncSystemConfigIntoLegacySharedCodexHome,
  syncSystemConfigIntoManagedCodexHome
} from './codex-config-mirror'

// A config shaped like the one in the report: an MCP server whose bearer token
// lives literally in the file. Whether a given user's config carries one is up
// to them, which is exactly why the mirror cannot decide the mode per-content.
const CONFIG_WITH_SECRET = [
  'model = "gpt-5"',
  '',
  '[mcp_servers.example.http_headers]',
  'Authorization = "Bearer super-secret-token"',
  ''
].join('\n')

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

const systemHome = (): string => join(fakeHomeDir, '.codex')
const systemConfigPath = (): string => join(systemHome(), 'config.toml')
const runtimeConfigPath = (): string =>
  join(userDataDir, 'codex-runtime-home', 'home', 'config.toml')
const modeOf = (path: string): string => (statSync(path).mode & 0o777).toString(8)

beforeEach(() => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-mode-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-mode-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  mkdirSync(systemHome(), { recursive: true })
  writeFileSync(systemConfigPath(), CONFIG_WITH_SECRET, 'utf-8')
  chmodSync(systemConfigPath(), 0o600)
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
})

describe.skipIf(process.platform === 'win32')('runtime config.toml file mode (STA-6706)', () => {
  it('creates the mirrored copy owner-only, not world-readable', () => {
    syncSystemConfigIntoManagedCodexHome()

    // 0644 on a file that can hold an MCP bearer token is the reported defect.
    expect(modeOf(runtimeConfigPath())).toBe('600')
  })

  it('repairs a copy that is already world-readable, even with identical bytes', () => {
    syncSystemConfigIntoManagedCodexHome()
    chmodSync(runtimeConfigPath(), 0o644)
    expect(modeOf(runtimeConfigPath())).toBe('644')

    // The mirror skips the write when content matches, so repair cannot depend
    // on a rewrite — the user most needing this has a file that never changes.
    syncSystemConfigIntoManagedCodexHome()

    expect(modeOf(runtimeConfigPath())).toBe('600')
  })

  // A dangling runtime symlink used to throw out of the mode repair, land in this lane's catch,
  // and return before any mirror ran — permanently, on every later pass, with nothing that
  // self-corrects. Covering the repair helper alone would not have caught it: the helper is
  // shared with the legacy lane, which does not regress, and the damage is what the throw does
  // to THIS lane's control flow.
  it('still mirrors when the runtime config is a dangling symlink', () => {
    syncSystemConfigIntoManagedCodexHome()
    unlinkSync(runtimeConfigPath())
    symlinkSync(join(userDataDir, 'target-that-does-not-exist.toml'), runtimeConfigPath())
    expect(lstatSync(runtimeConfigPath()).isSymbolicLink()).toBe(true)
    expect(existsSync(runtimeConfigPath())).toBe(false)

    writeFileSync(systemConfigPath(), `${CONFIG_WITH_SECRET}new_setting = true\n`, 'utf-8')
    syncSystemConfigIntoManagedCodexHome()

    // The dangling link is replaced with a real file carrying the new setting, which is what the
    // lane did before this PR. Asserting the content, not just the absence of a throw: a mirror
    // that returns quietly without writing is the failure being guarded against.
    expect(lstatSync(runtimeConfigPath()).isSymbolicLink()).toBe(false)
    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toContain('new_setting = true')
    expect(modeOf(runtimeConfigPath())).toBe('600')
  })

  // The one cell the repair did not reach. A stalled promotion returns before the mirror runs, so
  // a runtime config already at 0644 stayed there — with its token-bearing .bak beside it — for as
  // long as the stall lasted. Not a regression (the merge base is 644 here too), but unfinished
  // business of this PR's own goal: forcing 0600 on credential-bearing config files.
  //
  // The stall needs the ~/.codex DIRECTORY non-writable, not the file: promotion writes via
  // temp-file-plus-rename, which needs directory permission. A read-only config.toml does not
  // stall at all.
  it('repairs the mode even when promotion write-back has stalled', () => {
    syncSystemConfigIntoManagedCodexHome()
    writeFileSync(runtimeConfigPath(), 'model = "gpt-5-codex"\n', 'utf-8')
    chmodSync(runtimeConfigPath(), 0o644)
    chmodSync(systemHome(), 0o500)

    try {
      syncSystemConfigIntoManagedCodexHome()

      // Witness that the promotion actually stalled. The runtime content alone cannot
      // show it: a successful promotion writes the runtime change back to the system
      // config and mirrors it straight back, so 'gpt-5-codex' is present either way.
      // Its ABSENCE from the system config is what only a stall produces -- without
      // which this test passes for the wrong reason wherever chmod does not bite,
      // such as running as root in a CI container.
      expect(readFileSync(systemConfigPath(), 'utf-8')).not.toContain('gpt-5-codex')
      expect(readFileSync(runtimeConfigPath(), 'utf-8')).toContain('gpt-5-codex')
      expect(modeOf(runtimeConfigPath())).toBe('600')
    } finally {
      chmodSync(systemHome(), 0o700)
    }
  })

  it('keeps the copy owner-only when the source itself is loose', () => {
    chmodSync(systemConfigPath(), 0o644)

    syncSystemConfigIntoManagedCodexHome()

    // Mirroring the source mode would leave this user — the likeliest to need
    // the fix — exposed, so the mode is forced rather than copied.
    expect(modeOf(runtimeConfigPath())).toBe('600')
  })

  it('does not loosen the source config', () => {
    syncSystemConfigIntoManagedCodexHome()

    expect(modeOf(systemConfigPath())).toBe('600')
  })
})

describe('runtime config.toml mirror idempotence (STA-6706)', () => {
  it('does not rewrite the file when nothing changed', () => {
    syncSystemConfigIntoManagedCodexHome()
    const path = runtimeConfigPath()
    // Backdate so any rewrite is unambiguous rather than lost in mtime
    // granularity.
    const past = new Date(Date.now() - 60_000)
    utimesSync(path, past, past)
    const before = statSync(path).mtimeMs

    syncSystemConfigIntoManagedCodexHome()
    syncSystemConfigIntoManagedCodexHome()

    expect(statSync(path).mtimeMs).toBe(before)
  })
})

describe.skipIf(process.platform === 'win32')('runtime config.toml backup mode (STA-6706)', () => {
  const backupPath = (): string => `${runtimeConfigPath()}.bak`

  it('repairs the rolling backup, which holds the same secret', () => {
    syncSystemConfigIntoManagedCodexHome()
    // The trust writer copies the whole file to <config>.bak before replacing
    // it, so the backup carries the same bearer token as the config.
    writeFileSync(backupPath(), CONFIG_WITH_SECRET, 'utf-8')
    chmodSync(backupPath(), 0o644)

    syncSystemConfigIntoManagedCodexHome()

    expect(modeOf(backupPath())).toBe('600')
    expect(modeOf(runtimeConfigPath())).toBe('600')
  })

  it('repairs a backup orphaned by a deleted primary', () => {
    syncSystemConfigIntoManagedCodexHome()
    writeFileSync(backupPath(), CONFIG_WITH_SECRET, 'utf-8')
    chmodSync(backupPath(), 0o644)
    // Deleting the runtime config to force a clean re-mirror is the workaround
    // the report itself documents, and it lands in the fresh-write branch —
    // which never touched the orphan left behind.
    rmSync(runtimeConfigPath())

    syncSystemConfigIntoManagedCodexHome()

    expect(modeOf(backupPath())).toBe('600')
  })

  it('does not fail when no backup exists', () => {
    expect(() => syncSystemConfigIntoManagedCodexHome()).not.toThrow()
    expect(existsSync(backupPath())).toBe(false)
  })
})

// The home-local rewrite is reached only through the mirror. Proving the helper
// works in isolation never proves it is wired in — dropping the argument at the
// two call sites left the whole unit-test suite green.
describe('home-local rewrite reaches the mirrored file (STA-6706)', () => {
  const BUNDLED = '.tmp/bundled-marketplaces/openai-bundled'
  const writeMarketplaceConfig = (): void =>
    writeFileSync(
      systemConfigPath(),
      [
        'model = "gpt-5"',
        '',
        '[marketplaces.openai-bundled]',
        `source = "${systemHome()}/${BUNDLED}"`,
        ''
      ].join('\n'),
      'utf-8'
    )

  it('re-roots a bundled marketplace source in the written runtime config', () => {
    writeMarketplaceConfig()
    // Codex materialises this per home; the rewrite is conditional on it.
    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home', BUNDLED), { recursive: true })

    syncSystemConfigIntoManagedCodexHome()

    const written = readFileSync(runtimeConfigPath(), 'utf-8')
    // The runtime home, not the standalone one: pointing at ~/.codex is what
    // stops Codex recognising it as bundled and silently drops the plugin.
    expect(written).toContain(`codex-runtime-home/home/${BUNDLED}`)
    expect(written).not.toContain(`${systemHome()}/.tmp/bundled-marketplaces`)
  })

  it('leaves the source path alone when the runtime home has no bundled directory', () => {
    writeMarketplaceConfig()

    syncSystemConfigIntoManagedCodexHome()

    // The shared runtime home in the field is exactly this case. Today's value
    // at least resolves; replacing it with a nonexistent path would be worse.
    const written = readFileSync(runtimeConfigPath(), 'utf-8')
    expect(written).toContain(`${systemHome()}/${BUNDLED}`)
    expect(written).not.toContain(`codex-runtime-home/home/${BUNDLED}`)
  })
})

// The retired shared home is still a CODEX_HOME that a surviving pane reads,
// and `[marketplaces.*]` is not runtime-preserved — so a legacy lane that
// skipped the rewrite would keep rebuilding the un-rewritten value on every
// pass, and that pane would keep losing the bundled marketplace.
describe('legacy shared home gets the same home-local rewrite (STA-6706)', () => {
  it('re-roots a bundled marketplace source in the retired home too', () => {
    const legacyHome = join(userDataDir, 'legacy-shared-home')
    const bundled = '.tmp/bundled-marketplaces/openai-bundled'
    mkdirSync(join(legacyHome, bundled), { recursive: true })
    writeFileSync(
      systemConfigPath(),
      [
        'model = "gpt-5"',
        '',
        '[marketplaces.openai-bundled]',
        `source = "${systemHome()}/${bundled}"`,
        ''
      ].join('\n'),
      'utf-8'
    )

    syncSystemConfigIntoLegacySharedCodexHome({
      runtimeHomePath: legacyHome,
      systemHomePath: systemHome()
    })

    const written = readFileSync(join(legacyHome, 'config.toml'), 'utf-8')
    expect(written).toContain(`${legacyHome}/${bundled}`)
    expect(written).not.toContain(`${systemHome()}/${bundled}`)
  })
})

// The retired home has no other repairer, so its mode guarantees need holding
// here or nothing holds them.
describe.skipIf(process.platform === 'win32')('legacy shared home file mode (STA-6706)', () => {
  const legacyHome = (): string => join(userDataDir, 'legacy-shared-home')
  const legacyConfig = (): string => join(legacyHome(), 'config.toml')
  const syncLegacy = (): void =>
    syncSystemConfigIntoLegacySharedCodexHome({
      runtimeHomePath: legacyHome(),
      systemHomePath: systemHome()
    })

  beforeEach(() => mkdirSync(legacyHome(), { recursive: true }))

  it('writes a fresh legacy config owner-only', () => {
    syncLegacy()

    expect(modeOf(legacyConfig())).toBe('600')
  })

  it('repairs a loose primary and its identical-bytes backup', () => {
    syncLegacy()
    const bytes = readFileSync(legacyConfig(), 'utf-8')
    writeFileSync(`${legacyConfig()}.bak`, bytes, 'utf-8')
    chmodSync(legacyConfig(), 0o644)
    chmodSync(`${legacyConfig()}.bak`, 0o644)

    // Identical bytes means no rewrite, so only the repair pass can fix these.
    syncLegacy()

    expect(modeOf(legacyConfig())).toBe('600')
    expect(modeOf(`${legacyConfig()}.bak`)).toBe('600')
  })

  it.each([
    ['an absent source', null],
    ['a 0-byte cloud-synced source', '']
  ])('still repairs when the mirror cannot run: %s', (_case, source) => {
    syncLegacy()
    chmodSync(legacyConfig(), 0o644)
    writeFileSync(`${legacyConfig()}.bak`, 'model = "x"\n', 'utf-8')
    chmodSync(`${legacyConfig()}.bak`, 0o644)
    if (source === null) {
      rmSync(systemConfigPath())
    } else {
      writeFileSync(systemConfigPath(), source, 'utf-8')
    }

    syncLegacy()

    // The mirror returns early here; the repair must not be behind that return.
    expect(modeOf(legacyConfig())).toBe('600')
    expect(modeOf(`${legacyConfig()}.bak`)).toBe('600')
  })
})

// The conditional rewrite can only ever land on a pass where the runtime home
// already has the bundled directory — which is never the first pass, because
// Codex materialises it. So the merge branch is the only path by which this
// fix reaches a user, and it is the one that most needs holding.
describe('the merge branch carries the home-local rewrite (STA-6706)', () => {
  const BUNDLED = '.tmp/bundled-marketplaces/openai-bundled'
  const marketplaceConfig = (): string =>
    [
      'model = "gpt-5"',
      '',
      '[marketplaces.openai-bundled]',
      `source = "${systemHome()}/${BUNDLED}"`,
      ''
    ].join('\n')

  it('re-roots on a later managed pass, not only on the first', () => {
    writeFileSync(systemConfigPath(), marketplaceConfig(), 'utf-8')
    // First pass: the directory does not exist yet, so the rewrite declines and
    // a runtime config is written. This is the real-world sequence.
    syncSystemConfigIntoManagedCodexHome()
    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toContain(`${systemHome()}/${BUNDLED}`)

    mkdirSync(join(userDataDir, 'codex-runtime-home', 'home', BUNDLED), { recursive: true })
    writeFileSync(systemConfigPath(), `${marketplaceConfig()}\napproval_policy = "on-request"\n`)
    syncSystemConfigIntoManagedCodexHome()

    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toContain(
      `codex-runtime-home/home/${BUNDLED}`
    )
  })

  it('re-roots on a later legacy pass too', () => {
    const legacyHome = join(userDataDir, 'legacy-merge-home')
    mkdirSync(legacyHome, { recursive: true })
    const sync = (): void =>
      syncSystemConfigIntoLegacySharedCodexHome({
        runtimeHomePath: legacyHome,
        systemHomePath: systemHome()
      })
    writeFileSync(systemConfigPath(), marketplaceConfig(), 'utf-8')
    sync()
    expect(readFileSync(join(legacyHome, 'config.toml'), 'utf-8')).toContain(
      `${systemHome()}/${BUNDLED}`
    )

    mkdirSync(join(legacyHome, BUNDLED), { recursive: true })
    writeFileSync(systemConfigPath(), `${marketplaceConfig()}\napproval_policy = "on-request"\n`)
    sync()

    expect(readFileSync(join(legacyHome, 'config.toml'), 'utf-8')).toContain(
      `${legacyHome}/${BUNDLED}`
    )
  })

  it('keeps the merged managed write owner-only', () => {
    writeFileSync(systemConfigPath(), marketplaceConfig(), 'utf-8')
    syncSystemConfigIntoManagedCodexHome()
    writeFileSync(systemConfigPath(), `${marketplaceConfig()}\napproval_policy = "on-request"\n`)

    syncSystemConfigIntoManagedCodexHome()

    expect(modeOf(runtimeConfigPath())).toBe('600')
  })
})
