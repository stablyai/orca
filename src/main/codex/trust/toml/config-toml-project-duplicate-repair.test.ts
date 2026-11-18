import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { repairOrcaDuplicateTrustTables } from './config-toml-project-duplicate-repair'
// Use distinct project paths because repair refusals are logged once per reason.
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
})

describe('repairing configs broken by #22592', () => {
  it('removes the bare trust_level line Orca inserted under a quoted key', () => {
    const broken = [
      '["projects"."/repo-c"]',
      'trust_level = "trusted"',
      '"trust_level" = "trusted"',
      ''
    ].join('\r\n')

    const repaired = repairOrcaDuplicateTrustTables(broken)

    expect(repaired).toBe(['["projects"."/repo-c"]', '"trust_level" = "trusted"', ''].join('\r\n'))
  })

  it('leaves the file untouched when another duplicate would still break it', () => {
    const broken = [
      '["projects"."/repo-e"]',
      'trust_level = "trusted"',
      '',
      '[profiles.fast]',
      'model = "a"',
      '',
      '["profiles"."fast"]',
      'model = "b"',
      '',
      '[projects."/repo-e"]',
      'trust_level = "trusted"',
      ''
    ].join('\n')

    expect(repairOrcaDuplicateTrustTables(broken)).toBe(broken)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
