import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// Pipe the baseline policy on stdin. Catalog repair mutates only fresh in-memory copies.
const policyPath = path.resolve('config/scripts/locale-translation-policy.mjs')
const verifierPath = path.resolve('config/scripts/verify-localization-catalog.mjs')
const sources = [readFileSync(0, 'utf8'), readFileSync(policyPath, 'utf8')]
assert(sources.every((source) => source.includes('function includesPreservedLatinTerm(')))
const modules = await Promise.all(
  sources.map(async (source) => {
    const result = await build({
      entryPoints: [verifierPath],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      plugins: [
        {
          name: 'actual-locale-policy',
          setup(builder) {
            builder.onResolve({ filter: /^\.\// }, (args) => {
              const resolved = path.resolve(args.resolveDir, args.path)
              return resolved === policyPath
                ? { path: resolved }
                : { path: pathToFileURL(resolved).href, external: true }
            })
            builder.onResolve({ filter: /^typescript-api$/ }, () => ({
              path: import.meta.resolve('typescript-api'),
              external: true
            }))
            builder.onLoad({ filter: /locale-translation-policy\.mjs$/ }, () => ({
              contents: `${source}\nexport { includesPreservedLatinTerm };`,
              resolveDir: path.dirname(policyPath)
            }))
            builder.onLoad({ filter: /verify-localization-catalog\.mjs$/ }, () => ({
              contents: `${readFileSync(verifierPath, 'utf8')}\nexport * from './locale-translation-policy.mjs';`,
              resolveDir: path.dirname(verifierPath)
            }))
          }
        }
      ]
    })
    const code = `${result.outputFiles[0].text}\n//# sourceURL=locale-brand-prefilter-bundle.js`
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  })
)

const brands = [
  ...new Set(Object.values(modules[0].BRAND_MISTRANSLATIONS).flatMap(Object.keys)),
  '',
  '_',
  'a_b',
  'a.b',
  '[term]',
  '界',
  '\ud800'
]
const boundaries = ['', ' ', 'X', '_', '2', '.', '-', '\n', '\0', 'é', '界', '😀', '\ud800']
let comparisons = 0
for (const term of brands) {
  for (const prefix of boundaries) {
    for (const suffix of boundaries) {
      for (const value of [
        `${prefix}${term}${suffix}`,
        `X${term}X ${prefix}${term}${suffix}`,
        `${prefix}${term.toLowerCase()}${suffix}`,
        `${prefix}${suffix}`
      ]) {
        assert.equal(
          modules[1].includesPreservedLatinTerm(value, term),
          modules[0].includesPreservedLatinTerm(value, term)
        )
        comparisons += 1
      }
    }
  }
}
console.log(`${comparisons} literal/boundary differential cases match`)

let repairCases = 0
for (const [locale, translations] of Object.entries(modules[0].BRAND_MISTRANSLATIONS)) {
  for (const [brand, wrongForms] of Object.entries(translations)) {
    for (const wrong of wrongForms) {
      for (const prefix of boundaries) {
        for (const key of [
          'fixture.brand',
          'fixture.search.brand',
          'auto.lib.agent.catalog.test'
        ]) {
          const input = {
            key,
            enValue: `${prefix}${brand}${prefix} fixture {{agent}}`,
            localeValue: `${wrong} ${prefix}${brand}${prefix} ${wrong} {{agent}}`,
            locale
          }
          assert.equal(
            modules[1].repairTranslatedValue(input),
            modules[0].repairTranslatedValue(input)
          )
          repairCases += 1
        }
      }
    }
  }
}
console.log(`${repairCases} full policy repair cases match`)

function measured(run) {
  const start = performance.now()
  const value = run()
  return { elapsed: performance.now() - start, value }
}

function benchmark(name, prepare) {
  const expected = prepare(modules[0])()
  assert.deepEqual(prepare(modules[1])(), expected)
  for (const module of modules) {
    const until = performance.now() + 150
    do {
      assert.deepEqual(prepare(module)(), expected)
    } while (performance.now() < until)
  }
  /** @type {number[][]} */
  const times = [[], []]
  for (let pair = 0; pair < 8; pair++) {
    for (const index of pair % 2 ? [1, 0] : [0, 1]) {
      const result = measured(prepare(modules[index]))
      times[index].push(result.elapsed)
      assert.deepEqual(result.value, expected)
    }
  }
  const median = times.map((values) => {
    const sorted = values.toSorted((a, b) => a - b)
    return (sorted[3] + sorted[4]) / 2
  })
  console.log(JSON.stringify({ name, median, times }))
}

console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    unit: 'ms'
  })
)
const localesDir = path.resolve('src/renderer/src/i18n/locales')
const en = JSON.parse(readFileSync(path.join(localesDir, 'en.json'), 'utf8'))
const enEntries = new Map(modules[0].collectStringLeaves(en).map(({ key, value }) => [key, value]))
for (const locale of ['zh', 'ja', 'ko', 'es', 'fr']) {
  const catalog = JSON.parse(readFileSync(path.join(localesDir, `${locale}.json`), 'utf8'))
  const localeEntries = new Map(
    modules[0].collectStringLeaves(catalog).map(({ key, value }) => [key, value])
  )
  const inputs = [...enEntries].flatMap(([key, enValue]) => {
    const localeValue = localeEntries.get(key)
    return typeof localeValue === 'string' ? [{ key, enValue, localeValue, locale }] : []
  })
  assert.deepEqual(
    inputs.map(modules[1].repairTranslatedValue),
    inputs.map(modules[0].repairTranslatedValue)
  )
  const expressionCounts = modules.map((module) => {
    const original = globalThis.RegExp
    let count = 0
    globalThis.RegExp = new Proxy(original, {
      construct(target, args) {
        if (typeof args[0] === 'string' && args[0].startsWith('(^|[^A-Za-z_])')) {
          count += 1
        }
        return Reflect.construct(target, args)
      }
    })
    try {
      inputs.forEach(module.repairTranslatedValue)
    } finally {
      globalThis.RegExp = original
    }
    return count
  })
  console.log(JSON.stringify({ locale, leaves: inputs.length, expressionCounts }))
  benchmark(`${locale}: repairCatalog`, (module) => {
    const copy = structuredClone(catalog)
    return () => ({ count: module.repairCatalog(en, copy, locale), catalog: copy })
  })
  benchmark(`${locale}: collectGenericTermRegressions`, (module) => {
    return () => module.collectGenericTermRegressions(enEntries, localeEntries, locale)
  })
}

for (const [name, enValue, localeValue] of [
  ['absent brands', 'Choose an endpoint.', 'Elegir un destino.'],
  ['matching brand', 'Use Gemini.', 'Usar Géminis.'],
  ['embedded only', 'Use _Gemini_.', 'Usar Géminis.'],
  ['all brands', brands.join(' '), brands.join(' ')]
]) {
  const input = { key: 'fixture.brand', enValue, localeValue, locale: 'es' }
  benchmark(`10k strings: ${name}`, (module) => () => {
    let result
    for (let i = 0; i < 10000; i++) {
      result = module.repairTranslatedValue(input)
    }
    return result
  })
}

const cache = new Map([
  ['Use Gemini.', 'Usar Géminis.'],
  ['Choose an endpoint.', 'Elegir un destino.'],
  ['Use _Gemini_.', 'Usar Géminis.'],
  ['Use GitHub Copilot.', 'Usar Copiloto de GitHub.']
])
const caches = modules.map((module) => {
  const copy = new Map(cache)
  return { count: module.repairCacheMap(copy, 'es'), entries: [...copy] }
})
assert.deepEqual(caches[1], caches[0])
console.log('Actual catalog outputs, regression reports, repair counts and cache mutation match')
