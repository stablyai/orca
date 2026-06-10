import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectModels, listModels } from './model-catalog'

describe('collectModels', () => {
  it('returns empty array when both inputs are undefined', () => {
    expect(collectModels(undefined, undefined)).toEqual([])
  })

  it('returns empty array when both inputs are null', () => {
    expect(collectModels(null, null)).toEqual([])
  })

  it('returns the configured default model marked isDefault: true', () => {
    const settings = { model: 'claude-opus-4-8[1m]' }
    const result = collectModels(settings, undefined)
    expect(result).toEqual([{ id: 'claude-opus-4-8[1m]', isDefault: true }])
  })

  it('ignores non-string model field in settings', () => {
    const settings = { model: 42 }
    const result = collectModels(settings, undefined)
    expect(result).toEqual([])
  })

  it('collects keys from lastModelUsage across projects', () => {
    const claudeJson = {
      projects: {
        '/some/project': {
          lastModelUsage: {
            'claude-haiku-4-5-20251001': {},
            'claude-opus-4-7[1m]': {}
          }
        }
      }
    }
    const result = collectModels(undefined, claudeJson)
    const ids = result.map((e) => e.id)
    expect(ids).toContain('claude-haiku-4-5-20251001')
    expect(ids).toContain('claude-opus-4-7[1m]')
    expect(result.every((e) => !e.isDefault)).toBe(true)
  })

  it('deduplicates model ids across projects', () => {
    const claudeJson = {
      projects: {
        '/project/a': { lastModelUsage: { 'claude-opus-4-8[1m]': {} } },
        '/project/b': { lastModelUsage: { 'claude-opus-4-8[1m]': {} } }
      }
    }
    const result = collectModels(undefined, claudeJson)
    expect(result.filter((e) => e.id === 'claude-opus-4-8[1m]')).toHaveLength(1)
  })

  it('deduplicates when default is also in lastModelUsage', () => {
    const settings = { model: 'claude-opus-4-8[1m]' }
    const claudeJson = {
      projects: {
        '/project/a': {
          lastModelUsage: { 'claude-opus-4-8[1m]': {}, 'claude-haiku-4-5-20251001': {} }
        }
      }
    }
    const result = collectModels(settings, claudeJson)
    expect(result.filter((e) => e.id === 'claude-opus-4-8[1m]')).toHaveLength(1)
    const defaultEntry = result.find((e) => e.id === 'claude-opus-4-8[1m]')
    expect(defaultEntry?.isDefault).toBe(true)
  })

  it('puts the default model first', () => {
    const settings = { model: 'claude-opus-4-8[1m]' }
    const claudeJson = {
      projects: {
        '/project/a': {
          lastModelUsage: { 'claude-haiku-4-5-20251001': {}, 'claude-opus-4-7[1m]': {} }
        }
      }
    }
    const result = collectModels(settings, claudeJson)
    expect(result[0].id).toBe('claude-opus-4-8[1m]')
  })

  it('sorts remaining models descending alphabetically', () => {
    const claudeJson = {
      projects: {
        '/p': {
          lastModelUsage: {
            'claude-opus-4-7[1m]': {},
            'claude-opus-4-8[1m]': {},
            'claude-haiku-4-5-20251001': {}
          }
        }
      }
    }
    const result = collectModels(undefined, claudeJson)
    const ids = result.map((e) => e.id)
    // descending alpha: opus-4-8 > opus-4-7 > haiku-4-5
    expect(ids.indexOf('claude-opus-4-8[1m]')).toBeLessThan(ids.indexOf('claude-opus-4-7[1m]'))
    expect(ids.indexOf('claude-opus-4-7[1m]')).toBeLessThan(
      ids.indexOf('claude-haiku-4-5-20251001')
    )
  })

  it('tolerates projects entries without lastModelUsage', () => {
    const claudeJson = {
      projects: {
        '/project/a': {},
        '/project/b': { lastModelUsage: { 'claude-haiku-4-5-20251001': {} } }
      }
    }
    const result = collectModels(undefined, claudeJson)
    expect(result.map((e) => e.id)).toContain('claude-haiku-4-5-20251001')
  })

  it('tolerates missing projects key in claudeJson', () => {
    const result = collectModels(undefined, { numStartups: 5 })
    expect(result).toEqual([])
  })
})

describe('listModels', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = join(tmpdir(), `orca-model-catalog-test-${Date.now()}`)
    mkdirSync(join(tmpHome, '.claude'), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('reads from settings.json and .claude.json and returns combined results', async () => {
    writeFileSync(
      join(tmpHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'claude-fable-5[1m]' })
    )
    writeFileSync(
      join(tmpHome, '.claude.json'),
      JSON.stringify({
        projects: {
          '/some/project': {
            lastModelUsage: {
              'claude-opus-4-8[1m]': {},
              'claude-haiku-4-5-20251001': {}
            }
          }
        }
      })
    )

    const result = await listModels(tmpHome)
    expect(result[0]).toEqual({ id: 'claude-fable-5[1m]', isDefault: true })
    const ids = result.map((e) => e.id)
    expect(ids).toContain('claude-opus-4-8[1m]')
    expect(ids).toContain('claude-haiku-4-5-20251001')
  })

  it('returns whatever is available when settings.json is missing', async () => {
    writeFileSync(
      join(tmpHome, '.claude.json'),
      JSON.stringify({
        projects: {
          '/p': { lastModelUsage: { 'claude-opus-4-7[1m]': {} } }
        }
      })
    )

    const result = await listModels(tmpHome)
    expect(result.map((e) => e.id)).toContain('claude-opus-4-7[1m]')
  })

  it('returns empty array when both files are missing', async () => {
    const result = await listModels(tmpHome)
    expect(result).toEqual([])
  })
})
