import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
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
})

describe('readConfigFromOrcaOverlapDetail', () => {
  it('warns when read_config_from imports another Orca-managed agent', () => {
    const detail = readConfigFromOrcaOverlapDetail({
      hooks: {},
      read_config_from: ['claude', 'custom']
    })

    expect(detail).toContain('read_config_from')
    expect(detail).toContain('claude')
  })
})