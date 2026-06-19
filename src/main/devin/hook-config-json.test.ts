import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseDevinHooksConfigText,
  readConfigFromOrcaOverlapDetail,
  readDevinHooksConfig
} from './hook-config-json'

describe('readDevinHooksConfig', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-devin-jsonc-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('parses JSONC comments in Devin config', () => {
    const path = join(dir, 'config.json')
    writeFileSync(
      path,
      `{
  // Devin user hooks
  "hooks": {},
  "permissions": { "mode": "normal" }
}
`
    )

    const config = readDevinHooksConfig(path)

    expect(config).toEqual({
      hooks: {},
      permissions: { mode: 'normal' }
    })
  })

  it('rejects recovered partial parses from malformed JSONC', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(parseDevinHooksConfigText('{"hooks": }', 'Devin config.json')).toBeNull()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not parse Devin config.json')
      )
    } finally {
      warn.mockRestore()
    }
  })
})

describe('readConfigFromOrcaOverlapDetail', () => {
  it('warns when legacy read_config_from imports Claude', () => {
    const detail = readConfigFromOrcaOverlapDetail({
      hooks: {},
      read_config_from: ['claude', 'custom']
    })

    expect(detail).toContain('read_config_from')
    expect(detail).toContain('claude')
  })

  it('warns when object-shaped read_config_from leaves Claude enabled', () => {
    const detail = readConfigFromOrcaOverlapDetail({
      hooks: {},
      read_config_from: { claude: true }
    })

    expect(detail).toContain('read_config_from.claude')
  })

  it('warns when read_config_from is omitted because imports default to enabled', () => {
    const detail = readConfigFromOrcaOverlapDetail({
      hooks: {}
    })

    expect(detail).toContain('read_config_from.claude')
  })

  it('does not warn when read_config_from disables Claude', () => {
    const detail = readConfigFromOrcaOverlapDetail({
      hooks: {},
      read_config_from: { claude: false }
    })

    expect(detail).toBeNull()
  })
})
