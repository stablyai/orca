import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'

let root: string
let runtimeHomePath: string
let systemHomePath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-plugin-promotion-'))
  runtimeHomePath = join(root, 'managed')
  systemHomePath = join(root, 'system')
  mkdirSync(runtimeHomePath)
  mkdirSync(systemHomePath)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function mirror(): void {
  syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
}

function config(home: string): string {
  return readFileSync(join(home, 'config.toml'), 'utf-8')
}

function writeConfig(home: string, content: string): void {
  writeFileSync(join(home, 'config.toml'), content, 'utf-8')
}

function registeredConfig(enabled = true): string {
  return `model = "gpt-5"

[marketplaces.acme]
last_updated = "2026-07-25T00:00:00Z"
source_type = "git"
source = "https://example.invalid/acme/plugins.git"

[plugins."formatter@acme"]
enabled = ${enabled}
`
}

describe('Codex plugin registration promotion', () => {
  it('promotes quoted registrations byte-stably without disturbing comments, CRLF, or order', () => {
    writeConfig(
      systemHomePath,
      '# system preamble\r\nmodel = "gpt-5"\r\n\r\n[features]\r\nhooks = true\r\n'
    )
    mirror()

    writeConfig(
      runtimeHomePath,
      `${config(runtimeHomePath)}
# marketplace note
["marketplaces"."acme"] # source stays documented
source_type = "git"
source = "https://example.invalid/acme/plugins.git"

[plugins.'formatter@acme']
# user choice
enabled = true
`
    )
    mirror()

    const system = config(systemHomePath)
    expect(system).toBe(
      '# system preamble\r\n' +
        'model = "gpt-5"\r\n' +
        '\r\n' +
        '[features]\r\n' +
        'hooks = true\r\n' +
        '\r\n' +
        '# marketplace note\r\n' +
        '["marketplaces"."acme"] # source stays documented\r\n' +
        'source_type = "git"\r\n' +
        'source = "https://example.invalid/acme/plugins.git"\r\n' +
        '\r\n' +
        "[plugins.'formatter@acme']\r\n" +
        '# user choice\r\n' +
        'enabled = true\r\n'
    )

    const settledRuntime = config(runtimeHomePath)
    mirror()
    expect(config(systemHomePath)).toBe(system)
    expect(config(runtimeHomePath)).toBe(settledRuntime)
    expect(config(systemHomePath).match(/formatter@acme/g)).toHaveLength(1)
  })

  it('promotes an enabled change and does not revive the prior value', () => {
    writeConfig(systemHomePath, registeredConfig())
    mirror()

    writeConfig(
      runtimeHomePath,
      config(runtimeHomePath).replace('enabled = true', 'enabled = false')
    )
    mirror()

    expect(config(systemHomePath)).toContain('enabled = false')
    expect(config(runtimeHomePath)).toContain('enabled = false')
    mirror()
    expect(config(systemHomePath)).not.toContain('enabled = true')
    expect(config(systemHomePath).match(/\[plugins\./g)).toHaveLength(1)
  })

  it('creates a missing system config from a registration-only install', () => {
    mirror()
    writeConfig(
      runtimeHomePath,
      `[marketplaces.acme]
source_type = "git"
source = "https://example.invalid/acme/plugins.git"

[plugins."formatter@acme"]
enabled = true
`
    )

    mirror()

    expect(config(systemHomePath)).toContain('[marketplaces.acme]')
    expect(config(systemHomePath)).toContain('[plugins."formatter@acme"]')
    expect(config(runtimeHomePath)).toContain('[plugins."formatter@acme"]')
  })

  it('lets an outside edit to the same registration win a conflict', () => {
    writeConfig(systemHomePath, registeredConfig())
    mirror()

    writeConfig(
      runtimeHomePath,
      config(runtimeHomePath).replace('enabled = true', 'enabled = false')
    )
    writeConfig(
      systemHomePath,
      config(systemHomePath).replace('enabled = true', 'enabled = true # outside edit')
    )
    mirror()

    expect(config(systemHomePath)).toContain('enabled = true # outside edit')
    expect(config(runtimeHomePath)).toContain('enabled = true # outside edit')
    expect(config(runtimeHomePath)).not.toContain('enabled = false')
  })

  it('anchors divergent registrations from a legacy baseline', () => {
    writeConfig(systemHomePath, registeredConfig())
    mirror()
    const baselinePath = join(runtimeHomePath, '.orca-config-settings-baseline.json')
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'))
    delete baseline.pluginRegistrations
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`)

    writeConfig(
      runtimeHomePath,
      config(runtimeHomePath).replace('enabled = true', 'enabled = false')
    )
    writeConfig(
      systemHomePath,
      config(systemHomePath).replace('enabled = true', 'enabled = true # outside edit')
    )
    mirror()

    expect(config(systemHomePath)).toContain('enabled = true # outside edit')
    expect(config(runtimeHomePath)).toContain('enabled = false')
    const conflicts = JSON.parse(readFileSync(baselinePath, 'utf-8')).conflicts
    expect(conflicts['plugins."formatter@acme"']).toBeDefined()
  })

  it('promotes registration removals instead of resurrecting them', () => {
    writeConfig(systemHomePath, registeredConfig())
    mirror()

    writeConfig(runtimeHomePath, 'model = "gpt-5"\n')
    mirror()

    expect(config(systemHomePath)).not.toContain('[marketplaces.')
    expect(config(systemHomePath)).not.toContain('[plugins.')
    expect(config(runtimeHomePath)).not.toContain('[marketplaces.')
    expect(config(runtimeHomePath)).not.toContain('[plugins.')
    const settledSystem = config(systemHomePath)
    mirror()
    expect(config(systemHomePath)).toBe(settledSystem)
  })

  it('does not infer registrations from marketplace or plugin cache files', () => {
    writeConfig(systemHomePath, 'model = "gpt-5"\n')
    mirror()
    const pluginCache = join(runtimeHomePath, 'plugins', 'cache', 'formatter')
    const marketplaceCache = join(runtimeHomePath, '.tmp', 'marketplaces', 'acme')
    mkdirSync(pluginCache, { recursive: true })
    mkdirSync(marketplaceCache, { recursive: true })
    writeFileSync(join(pluginCache, 'plugin.json'), '{}')
    writeFileSync(join(marketplaceCache, 'marketplace.json'), '{}')

    mirror()

    expect(config(systemHomePath)).toBe('model = "gpt-5"\n')
    expect(config(runtimeHomePath)).not.toContain('[marketplaces.')
    expect(config(runtimeHomePath)).not.toContain('[plugins.')
  })
})
