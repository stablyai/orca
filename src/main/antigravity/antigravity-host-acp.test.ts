import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAcpModelCatalogProbe,
  type AcpModelCatalogProbeDeps
} from '../acp/discovery/acp-model-catalog-probe'
import { resolveAcpLaunchInvocation } from '../acp/launch/acp-structured-launch-resolution'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'
import { antigravityHostAccountHome, hasAgyCredential } from './antigravity-host-acp'

const homes: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true }))
})

describe('hasAgyCredential', () => {
  it('leaves a keyring-fallback marker to the ACP readiness probe', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-home-'))
    homes.push(home)
    const marker = join(home, '.gemini/antigravity-cli/cache/antigravity-keyring-unavailable')
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, '1794977777')
    await expect(hasAgyCredential(home)).resolves.toBe(true)
  })
})

describe('ANTIGRAVITY_LAUNCH_SPEC host backend environment', () => {
  it('disables agy background auto-updates for host ACP launches', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-host-env-'))
    homes.push(home)
    const invocation = await resolveAcpLaunchInvocation(
      ANTIGRAVITY_LAUNCH_SPEC,
      antigravityHostAccountHome(home),
      {
        resolveEnvironment: async () => ({ PATH: '', AGY_CLI_DISABLE_AUTO_UPDATE: 'false' }),
        resolveCommand: (command) => join(home, command),
        inheritedEnv: { AGY_CLI_DISABLE_AUTO_UPDATE: 'false' },
        homePath: home,
        dataDirectory: home
      }
    )
    expect(invocation.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true')
    expect(invocation.envToDelete).not.toContain('AGY_CLI_DISABLE_AUTO_UPDATE')
  })

  it('scrubs alternate-case auto-update flags on Windows so they cannot shadow the uppercase entry', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const home = mkdtempSync(join(tmpdir(), 'agy-host-win-env-'))
    homes.push(home)
    const invocation = await resolveAcpLaunchInvocation(
      ANTIGRAVITY_LAUNCH_SPEC,
      antigravityHostAccountHome(home),
      {
        resolveEnvironment: async () => ({ PATH: '', agy_cli_disable_auto_update: 'false' }),
        resolveCommand: (command) => join(home, command),
        inheritedEnv: { agy_cli_disable_auto_update: 'false' },
        homePath: home,
        dataDirectory: home
      }
    )
    expect(invocation.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true')
    expect(invocation.env.agy_cli_disable_auto_update).toBeUndefined()
    expect(invocation.envToDelete).toContain('agy_cli_disable_auto_update')
    expect(invocation.envToDelete).not.toContain('AGY_CLI_DISABLE_AUTO_UPDATE')
  })

  it('passes AGY_CLI_DISABLE_AUTO_UPDATE when listing models via agy models', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-host-models-'))
    homes.push(home)
    const runListing = vi.fn<NonNullable<AcpModelCatalogProbeDeps['runListing']>>(
      async () => 'gemini-4-neon-high\tGemini 4 Neon (High)\n'
    )
    const probe = createAcpModelCatalogProbe(ANTIGRAVITY_LAUNCH_SPEC, {
      resolveEnvironment: async () => ({ PATH: '' }),
      resolveCommand: (command) => join(home, command),
      probeVersion: async () => ({ version: '1.5.12' }),
      inheritedEnv: {},
      homePath: home,
      dataDirectory: home,
      runListing
    })
    const result = await probe(antigravityHostAccountHome(home), { workspacePath: home })
    expect(result.models).toHaveLength(1)
    expect(runListing).toHaveBeenCalledTimes(1)
    expect(runListing.mock.calls[0]?.[0]).toMatchObject({
      args: ['models'],
      env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }
    })
  })
})
