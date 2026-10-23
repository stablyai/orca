import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as CodexCommand from '../codex-cli/command'
import type * as TrustDerivation from './codex-hook-trust-derivation'

const mocks = vi.hoisted(() => ({
  homedir: vi.fn<() => string>(),
  codexPath: '',
  probeCodexVersion: vi.fn<(codexPath: string) => Promise<string | null>>(),
  deriveCodexHookHashes: vi.fn()
}))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: mocks.homedir
}))
vi.mock('../codex-cli/command', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexCommand>()),
  resolveCodexCommand: () => mocks.codexPath
}))
vi.mock('./codex-hook-trust-derivation', async (importOriginal) => ({
  ...(await importOriginal<typeof TrustDerivation>()),
  probeCodexVersion: mocks.probeCodexVersion,
  deriveCodexHookHashes: mocks.deriveCodexHookHashes
}))

import { CodexHookService } from './codex-hook-service-implementation'
import { _internals as reconcileInternals, startCodexHooks } from './codex-hook-reconcile'
import {
  _internals as lookupInternals,
  resolveCodexHookAnswer,
  startCodexHookHashLookup
} from './codex-hook-hash-lookup'
import { reconcileRealHomeCodexHookEntries } from './codex-real-home-hook-install'
import { CODEX_EVENT_LABEL } from './codex-hook-definition'
import type { CodexHookAnswer, CodexHookHashes } from './codex-hook-trust-derivation'

// Why this file: status reports on the home the next native pane gets, and
// says why ~/.codex has no status when Orca cannot approve its entry there.

let root: string
let home: string
let userData: string

const CODEX_HASHES: CodexHookHashes = Object.fromEntries(
  Object.values(CODEX_EVENT_LABEL).map((label) => [label, `sha256:codex-${label}`])
)
const hooksPath = (): string => join(home, '.codex', 'hooks.json')
const tomlPath = (): string => join(home, '.codex', 'config.toml')

/** Codex on PATH answers `next`; a pending answer removes it. */
async function answer(next: CodexHookAnswer): Promise<void> {
  if (next.kind === 'pending') {
    rmSync(mocks.codexPath)
  } else {
    writeFileSync(mocks.codexPath, next.codexVersion)
    mocks.probeCodexVersion.mockResolvedValue(next.codexVersion)
    mocks.deriveCodexHookHashes.mockResolvedValue(next)
  }
  startCodexHookHashLookup(Promise.resolve())
  await resolveCodexHookAnswer()
}

async function writeOrcaEntry(hashes: CodexHookHashes | null): Promise<void> {
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(hooksPath(), '{ "hooks": {} }\n')
  await reconcileRealHomeCodexHookEntries({
    hashes,
    isEnabled: () => true,
    convertOlderForms: true
  })
}

const status = () => new CodexHookService().getStatus()

beforeEach(() => {
  // Why realpath: a symlinked temp dir (macOS /var) would give ~/.codex a second key spelling.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-codex-real-home-status-')))
  home = join(root, 'home')
  userData = join(root, 'user-data')
  mkdirSync(home)
  mkdirSync(userData)
  vi.stubEnv('ORCA_USER_DATA_PATH', userData)
  vi.stubEnv('CODEX_HOME', '')
  mocks.homedir.mockReturnValue(home)
  mocks.codexPath = join(userData, 'codex')
  writeFileSync(mocks.codexPath, 'codex')
  reconcileInternals.resetForTesting()
  lookupInternals.resetForTesting()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('Codex hook status for ~/.codex', () => {
  it('reports on ~/.codex outside the app, naming the file, before Orca asked Codex', () => {
    expect(status()).toEqual({
      agent: 'codex',
      state: 'not_installed',
      configPath: hooksPath(),
      managedHooksPresent: false,
      detail: 'Orca has not asked Codex yet'
    })
  })

  it("is installed once ~/.codex holds Orca's entry approved with Codex's hash", async () => {
    await answer({ kind: 'hashes', codexVersion: 'codex-cli 0.160.1', hashes: CODEX_HASHES })
    await writeOrcaEntry(CODEX_HASHES)

    expect(status()).toMatchObject({ state: 'installed', detail: null })
  })

  it('says to update a Codex that cannot approve hooks', async () => {
    const failure = 'Codex 0.120.0 is too old for Orca status; update Codex'
    await answer({ kind: 'refused', codexVersion: 'codex-cli 0.120.0', failure })

    expect(status()).toMatchObject({ state: 'not_installed', detail: failure })
  })

  it("says Codex was not found, and that Orca's own approval stands until it answers", async () => {
    const failure = `Orca could not find Codex at ${mocks.codexPath}`
    await answer({ kind: 'pending', failure })
    expect(status()).toMatchObject({ state: 'not_installed', detail: failure })

    await writeOrcaEntry(null)

    expect(status()).toMatchObject({
      state: 'installed',
      detail: `Approved by Orca; not yet confirmed by Codex (${failure})`
    })
  })

  it('says why when config.toml keeps its approvals inline', async () => {
    await answer({ kind: 'hashes', codexVersion: 'codex-cli 0.160.1', hashes: CODEX_HASHES })
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(tomlPath(), 'model = "m"\nhooks = { state = {} }\n')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeOrcaEntry(CODEX_HASHES)

    expect(status()).toMatchObject({
      state: 'not_installed',
      detail: `${tomlPath()} keeps hook approvals inline, so Orca cannot add its own there; Orca shows no status for ~/.codex until they are tables`
    })
  })

  it.each([
    ['an unparseable file', '{ not json'],
    ['unknown top-level fields', JSON.stringify({ hooks: {}, _managed: true })],
    ['an event that is not a list', JSON.stringify({ hooks: { Stop: { note: 'mine' } } })]
  ])('reports on ~/.codex, and says why there is no status, for %s', async (_case, content) => {
    await answer({ kind: 'hashes', codexVersion: 'codex-cli 0.160.1', hashes: CODEX_HASHES })
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(hooksPath(), content)
    startCodexHooks({
      isEnabled: () => false,
      resolveLaunchHome: () => null,
      pathReady: Promise.resolve()
    })

    expect(status()).toEqual({
      agent: 'codex',
      state: 'error',
      configPath: hooksPath(),
      managedHooksPresent: false,
      detail: `Orca cannot add its hook to ${hooksPath()}, so Orca shows no status for ~/.codex`
    })
  })

  it("reports on a selected account's home without mentioning ~/.codex", async () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(hooksPath(), '{ not json')
    const accountHome = join(userData, 'codex-accounts', 'one', 'home')
    startCodexHooks({
      isEnabled: () => false,
      resolveLaunchHome: () => accountHome,
      pathReady: Promise.resolve()
    })

    expect(status()).toMatchObject({
      configPath: join(accountHome, 'hooks.json'),
      detail: 'Orca has not asked Codex yet'
    })
  })
})
