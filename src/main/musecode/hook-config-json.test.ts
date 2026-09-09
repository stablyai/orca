import { describe, expect, it } from 'vitest'
import { parseMusecodeSettingsText, serializeMusecodeSettings } from './hook-config-json'

describe('musecode hook-config-json', () => {
  it('creates a fresh settings file with the required schema_version', () => {
    expect(serializeMusecodeSettings(null, '/x/musecode-hooks.json')).toBe(
      '{\n  "schema_version": 1,\n  "managed_hooks_path": "/x/musecode-hooks.json"\n}\n'
    )
  })

  it('sets the pointer while preserving user keys and formatting', () => {
    const original = '{\n  "schema_version": 1,\n  "model": "muse-spark-1.2"\n}\n'
    const next = serializeMusecodeSettings(original, '/x/musecode-hooks.json')
    expect(next).toContain('"model": "muse-spark-1.2"')
    expect(JSON.parse(next)).toMatchObject({
      schema_version: 1,
      managed_hooks_path: '/x/musecode-hooks.json'
    })
  })

  it('removes the pointer on remove while keeping user keys', () => {
    const original =
      '{\n  "schema_version": 1,\n  "managed_hooks_path": "/x/musecode-hooks.json",\n  "model": "muse-spark-1.2"\n}\n'
    const next = serializeMusecodeSettings(original, undefined)
    const parsed = JSON.parse(next) as Record<string, unknown>
    expect(parsed.managed_hooks_path).toBeUndefined()
    expect(parsed.model).toBe('muse-spark-1.2')
    expect(parsed.schema_version).toBe(1)
  })

  it('leaves already-converged text untouched', () => {
    const original =
      '{\n  "schema_version": 1,\n  "managed_hooks_path": "/x/musecode-hooks.json"\n}\n'
    expect(serializeMusecodeSettings(original, '/x/musecode-hooks.json')).toBe(original)
  })

  it('rejects malformed settings text', () => {
    expect(parseMusecodeSettingsText('{oops', 'test')).toBeNull()
    expect(parseMusecodeSettingsText('[1,2]', 'test')).toBeNull()
  })
})
