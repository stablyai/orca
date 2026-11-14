import { describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import type * as ConfigTomlTrust from '../../trust/identity/codex-trust-identity'
import type * as TrustDerivation from '../../trust/hooks/codex-hook-trust-derivation'
import { setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: homedirMock
}))
vi.mock('../../trust/hooks/codex-hook-trust-derivation', async (importOriginal) =>
  (
    await import('../../trust/hooks/codex-hook-trust-derivation.test-fixture')
  ).answeringCodexForTests(await importOriginal<typeof TrustDerivation>())
)
// Exercise Windows trust-key sources on every test host.
vi.mock('../../trust/identity/codex-trust-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigTomlTrust>()),
  getExplicitHomeCodexHookSourcePath: (hooksJsonPath: string) =>
    `C:${hooksJsonPath.replace(/\//g, '\\')}`
}))

import './hook-service'
import { CodexHookService } from './codex-hook-service-implementation'
import {
  _internals as lookupInternals,
  startCodexHookHashLookup
} from '../../trust/hooks/codex-hook-hash-lookup'

const homes = setupCodexHookHomes(homedirMock, getPathMock)

describe('a managed home on Windows', () => {
  it('rewrites the backslash approval key that Codex reads when only the forward-slash one is left', async () => {
    lookupInternals.resetForTesting()
    startCodexHookHashLookup(Promise.resolve())
    const service = new CodexHookService()
    expect((await service.install()).state).toBe('installed')
    const tomlPath = join(homes.userDataDir, 'codex-runtime-home', 'home', 'config.toml')
    const installed = readFileSync(tomlPath, 'utf-8')
    const backslashTables = installed.match(/^\[hooks\.state\.'C:\\[^\n]*$/gm) ?? []
    expect(backslashTables.length).toBeGreaterThan(0)

    writeFileSync(
      tomlPath,
      installed.replace(/^\[hooks\.state\.'C:\\[^\n]*\n(?:(?!\[)[^\n]*\n?)*/gm, '')
    )
    expect(readFileSync(tomlPath, 'utf-8')).not.toMatch(/^\[hooks\.state\.'C:\\/m)
    expect(service.getStatus(join(homes.userDataDir, 'codex-runtime-home', 'home')).state).toBe(
      'partial'
    )

    expect((await service.install()).state).toBe('installed')

    expect(readFileSync(tomlPath, 'utf-8').match(/^\[hooks\.state\.'C:\\[^\n]*$/gm)).toEqual(
      backslashTables
    )
  })

  it('replaces a legacy forward-slash table with the backslash one, as main repairs it', async () => {
    lookupInternals.resetForTesting()
    startCodexHookHashLookup(Promise.resolve())
    const service = new CodexHookService()
    await service.install()
    const home = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const tomlPath = join(home, 'config.toml')
    const source = `C:${join(home, 'hooks.json').replace(/\//g, '\\')}`
    const canonical = `[hooks.state.'${source}:permission_request:0:0']`
    const legacy = `[hooks.state."${source.replace(/\\/g, '/')}:permission_request:0:0"]`
    const installed = readFileSync(tomlPath, 'utf-8')
    expect(installed).toContain(canonical)
    writeFileSync(tomlPath, installed.replace(canonical, legacy))

    expect(service.getStatus(home).state).toBe('partial')
    expect((await service.install()).state).toBe('installed')

    const repaired = readFileSync(tomlPath, 'utf-8')
    expect(repaired).not.toContain(legacy)
    expect(repaired).toContain(canonical)
  })
})
