import { describe, expect, it } from 'vitest'
import {
  MUSE_MANAGED_HOOK_ENV_VARS,
  parseMuseSettingsText,
  serializeMuseSettings
} from './hook-config-json'

describe('muse hook-config-json', () => {
  it('creates a fresh settings file with the required schema_version', () => {
    const parsed = parseMuseSettingsText(serializeMuseSettings(null, '/x/muse-hooks.json'), 'test')
    expect(parsed?.managed_hooks_env_vars).toEqual(MUSE_MANAGED_HOOK_ENV_VARS)
  })

  it('sets the pointer while preserving user keys and formatting', () => {
    const original = '{\n  "schema_version": 1,\n  "model": "muse-spark-1.2"\n}\n'
    const next = serializeMuseSettings(original, '/x/muse-hooks.json')
    expect(next).toContain('"model": "muse-spark-1.2"')
    expect(JSON.parse(next)).toMatchObject({
      schema_version: 1,
      managed_hooks_path: '/x/muse-hooks.json'
    })
  })

  it('removes the pointer on remove while keeping user keys', () => {
    const original =
      '{\n  "schema_version": 1,\n  "managed_hooks_path": "/x/muse-hooks.json",\n  "model": "muse-spark-1.2"\n}\n'
    const next = serializeMuseSettings(original, undefined)
    const parsed = parseMuseSettingsText(next, 'test')
    expect(parsed?.managed_hooks_path).toBeUndefined()
    expect(parsed?.model).toBe('muse-spark-1.2')
    expect(parsed?.schema_version).toBe(1)
  })

  it('leaves already-converged text untouched', () => {
    const original = JSON.stringify({
      schema_version: 1,
      managed_hooks_path: '/x/muse-hooks.json',
      managed_hooks_env_vars: MUSE_MANAGED_HOOK_ENV_VARS
    })
    expect(serializeMuseSettings(original, '/x/muse-hooks.json')).toBe(original)
  })

  it('rejects malformed settings text', () => {
    expect(parseMuseSettingsText('{oops', 'test')).toBeNull()
    expect(parseMuseSettingsText('[1,2]', 'test')).toBeNull()
  })
})
