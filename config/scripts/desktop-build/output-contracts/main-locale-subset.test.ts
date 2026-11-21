import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'rolldown'
import { describe, expect, it } from 'vitest'
import { createMainLocaleSubsetPlugin } from '../../../build-plugins/main-locale-subset'

const REGISTRY = 'src/main/plugins/contributions/plugin-language-pack-registry.ts'
const ENGLISH_CATALOG = resolve('src/renderer/src/i18n/locales/en.json')

type Hook = (...args: string[]) => unknown

function isHook(value: unknown): value is Hook {
  return typeof value === 'function'
}

function hook(value: unknown): Hook | null {
  if (isHook(value)) {
    return value
  }
  if (typeof value === 'object' && value !== null && 'handler' in value && isHook(value.handler)) {
    return value.handler
  }
  return null
}

function countStrings(catalog: unknown): number {
  if (typeof catalog !== 'object' || catalog === null) {
    return 0
  }
  let count = 0
  for (const value of Object.values(catalog)) {
    count += typeof value === 'string' ? 1 : countStrings(value)
  }
  return count
}

function parseLoadedCatalog(code: string): unknown {
  const text = code.startsWith('export default ') ? code.slice('export default '.length) : code
  return JSON.parse(text)
}

function englishImportSpecifier(): string {
  const source = readFileSync(REGISTRY, 'utf8')
  const match = source.match(/import\('([^']*locales\/en\.json[^']*)'\)/)
  if (!match) {
    throw new Error('language pack registry does not import the English catalog')
  }
  return match[1]
}

describe('main locale subset', () => {
  it('measures language-pack coverage against the whole English catalog', async () => {
    const plugin: Plugin = createMainLocaleSubsetPlugin()
    const buildStart = hook(plugin.buildStart)
    const resolveId = hook(plugin.resolveId)
    const load = hook(plugin.load)
    if (!buildStart || !load) {
      throw new Error('locale subset plugin is missing buildStart or load')
    }
    const context = { meta: { watchMode: false } }
    await buildStart.call(context)

    const subsetCode = await load.call(context, ENGLISH_CATALOG)
    if (typeof subsetCode !== 'string') {
      throw new Error('menu locale import was not subset')
    }
    const subsetCount = countStrings(parseLoadedCatalog(subsetCode))
    const fullCount = countStrings(JSON.parse(readFileSync(ENGLISH_CATALOG, 'utf8')))
    expect(subsetCount).toBeGreaterThan(0)
    expect(subsetCount).toBeLessThan(fullCount)

    const specifier = englishImportSpecifier()
    const query = specifier.includes('?') ? `?${specifier.slice(specifier.indexOf('?') + 1)}` : ''
    const resolved = resolveId ? await resolveId.call(context, specifier) : null
    const resolvedId = typeof resolved === 'string' ? resolved : `${ENGLISH_CATALOG}${query}`
    const coverageCode = await load.call(context, resolvedId)
    if (typeof coverageCode !== 'string') {
      throw new Error('language-pack English import produced no catalog')
    }
    expect(countStrings(parseLoadedCatalog(coverageCode))).toBe(fullCount)
  })
})
