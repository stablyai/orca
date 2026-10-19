import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as ConfigTomlTrust from './config-toml-trust'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('node:os')),
  homedir: homedirMock
}))
// Why: a Windows key source on any host, as Codex on Windows keys ~/.codex/hooks.json.
vi.mock('./config-toml-trust', async (importOriginal) => {
  const windowsPath = (path: string): string => `C:${path.replace(/\//g, '\\')}`
  return {
    ...(await importOriginal<typeof ConfigTomlTrust>()),
    normalizeCodexHookSourcePath: windowsPath,
    getCodexExplicitHomeHookSourcePath: windowsPath
  }
})

import { reconcileRealHomeCodexHookEntries } from './codex-real-home-hook-install'

let root: string
const tomlPath = (): string => join(root, 'home', '.codex', 'config.toml')
const BACKSLASH_TABLE = /^\[hooks\.state\.'C:\\[^\n]*$/gm

const reconcile = (): Promise<void> =>
  reconcileRealHomeCodexHookEntries({
    hashes: { stop: 'sha256:codex-stop' },
    isEnabled: () => true,
    convertOlderForms: true
  })

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-real-home-windows-keys-')))
  mkdirSync(join(root, 'home', '.codex'), { recursive: true })
  mkdirSync(join(root, 'user-data'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
  homedirMock.mockReturnValue(join(root, 'home'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('~/.codex on Windows', () => {
  it('rewrites the backslash approval key that Codex reads when only the forward-slash one is left', async () => {
    await reconcile()
    const installed = readFileSync(tomlPath(), 'utf-8')
    const backslashTables = installed.match(BACKSLASH_TABLE)
    expect(backslashTables).toHaveLength(1)
    writeFileSync(
      tomlPath(),
      installed.replace(/^\[hooks\.state\.'C:\\[^\n]*\n(?:(?!\[)[^\n]*\n?)*/gm, '')
    )

    await reconcile()

    expect(readFileSync(tomlPath(), 'utf-8').match(BACKSLASH_TABLE)).toEqual(backslashTables)
  })
})
