import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { setupCodexHookHomes } from './hook-service-test-harness'
import { readTomlValueAtPath } from './codex-config-toml-document'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: homedirMock
}))

import { CodexHookService } from './hook-service'

const homes = setupCodexHookHomes(homedirMock, getPathMock)

function orcaHookStates(configPath: string): unknown[] {
  const states = readTomlValueAtPath(parse(readFileSync(configPath, 'utf-8')), ['hooks', 'state'])
  return states && typeof states === 'object' ? Object.values(states) : []
}

describe('Orca turning its own Codex hook on respects the per-agent off switch (#23289 with #23667)', () => {
  it('re-enables a disabled Orca entry when Codex hooks are on, and leaves it off when Codex is turned off', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "m"\n', 'utf-8')
    mkdirSync(join(homes.userDataDir, 'codex-runtime-home', 'home'), { recursive: true })
    // Why: temp dirs are symlinked on macOS; use the canonical home the installer keys trust by.
    const runtimeHome = realpathSync.native(join(homes.userDataDir, 'codex-runtime-home', 'home'))
    const runtimeToml = join(runtimeHome, 'config.toml')
    const service = new CodexHookService()

    await service.prepareRuntimeHomeForLaunch(runtimeHome, undefined, true)
    const disableAll = () =>
      writeFileSync(
        runtimeToml,
        readFileSync(runtimeToml, 'utf-8').replaceAll('enabled = true', 'enabled = false'),
        'utf-8'
      )

    // Codex hooks on: the next launch prep turns Orca's existing disabled entries back on.
    disableAll()
    await service.prepareRuntimeHomeForLaunch(runtimeHome, undefined, true)
    const states = orcaHookStates(runtimeToml)
    expect(states.length).toBeGreaterThan(0)
    expect(states).not.toContainEqual(expect.objectContaining({ enabled: false }))

    // Codex turned off per agent: launch prep passes hooksEnabled = false and nothing turns back on.
    disableAll()
    await service.prepareRuntimeHomeForLaunch(runtimeHome, undefined, false)
    expect(readFileSync(join(runtimeHome, 'hooks.json'), 'utf-8')).not.toContain('codex-hook')
    expect(orcaHookStates(runtimeToml)).not.toContainEqual(
      expect.objectContaining({ enabled: true })
    )
  })
})
