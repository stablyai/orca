import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import type * as ConfigTomlTrust from '../../trust/identity/codex-trust-identity'
import type * as TrustDerivation from '../../trust/hooks/codex-hook-trust-derivation'
import { upsertHookTrustContent } from '../../trust/toml/config-toml-hook-trust-edit'
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
  it('restores missing backslash approvals and replaces legacy forward-slash tables', async () => {
    lookupInternals.resetForTesting()
    startCodexHookHashLookup(Promise.resolve())
    const service = new CodexHookService()
    expect((await service.install()).state).toBe('installed')
    const home = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const tomlPath = join(home, 'config.toml')
    const installed = readFileSync(tomlPath, 'utf-8')
    const backslashTables = installed.match(/^\[hooks\.state\.'C:\\[^\n]*$/gm) ?? []
    expect(backslashTables.length).toBeGreaterThan(0)

    writeFileSync(
      tomlPath,
      installed.replace(/^\[hooks\.state\.'C:\\[^\n]*\n(?:(?!\[)[^\n]*\n?)*/gm, '')
    )
    expect(readFileSync(tomlPath, 'utf-8')).not.toMatch(/^\[hooks\.state\.'C:\\/m)
    expect(service.getStatus(home).state).toBe('partial')

    expect((await service.install()).state).toBe('installed')

    expect(readFileSync(tomlPath, 'utf-8').match(/^\[hooks\.state\.'C:\\[^\n]*$/gm)).toEqual(
      backslashTables
    )
    const source = `C:${join(home, 'hooks.json').replace(/\//g, '\\')}`
    const canonical = `[hooks.state.'${source}:permission_request:0:0']`
    const legacy = `[hooks.state."${source.replace(/\\/g, '/')}:permission_request:0:0"]`
    const restored = readFileSync(tomlPath, 'utf-8')
    expect(restored).toContain(canonical)
    writeFileSync(tomlPath, restored.replace(canonical, legacy))

    expect(service.getStatus(home).state).toBe('partial')
    expect((await service.install()).state).toBe('installed')

    const repaired = readFileSync(tomlPath, 'utf-8')
    expect(repaired).not.toContain(legacy)
    expect(repaired).toContain(canonical)
  })

  it('keeps a hook approval Codex re-recorded under the backslash key when the ~/.codex hash was stale', async () => {
    lookupInternals.resetForTesting()
    startCodexHookHashLookup(Promise.resolve())
    const systemHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemHome, 'hooks.json')
    const systemTomlPath = join(systemHome, 'config.toml')
    mkdirSync(systemHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook' }] }]
        }
      })
    )
    const currentHash = 'sha256:reapproved'
    writeFileSync(
      systemTomlPath,
      upsertHookTrustContent('', [
        {
          sourcePath: systemHooksPath,
          eventLabel: 'pre_tool_use',
          groupIndex: 0,
          handlerIndex: 0,
          command: 'user-hook',
          matcher: 'Bash',
          trustedHash: 'sha256:stale',
          enabled: true
        }
      ])
    )
    const service = new CodexHookService()
    expect((await service.install()).state).toBe('installed')
    const runtimeTomlPath = join(homes.userDataDir, 'codex-runtime-home', 'home', 'config.toml')
    const mirrored = readFileSync(runtimeTomlPath, 'utf-8')
    expect(mirrored.match(/sha256:stale/g)).toHaveLength(2)

    // Codex rewrites only the backslash key it reads when the user approves again.
    writeFileSync(
      runtimeTomlPath,
      mirrored.replace(/^\[hooks\.state\.'C:\\[^\n]*\n(?:(?!\[)[^\n]*\n?)*/gm, (table) =>
        table.replace('sha256:stale', currentHash)
      )
    )
    expect((await service.install()).state).toBe('installed')

    expect(readFileSync(systemTomlPath, 'utf-8')).toContain(`trusted_hash = "${currentHash}"`)
    const runtime = readFileSync(runtimeTomlPath, 'utf-8')
    expect(runtime).not.toContain('sha256:stale')
    expect(runtime.match(new RegExp(currentHash, 'g'))).toHaveLength(2)
  })
})
