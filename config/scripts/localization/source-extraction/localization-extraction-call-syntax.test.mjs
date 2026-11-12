import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findKeys } from 'i18next-cli'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const commonJsFindKeys = require('i18next-cli').findKeys

describe.each([
  ['ES module', findKeys],
  ['CommonJS', commonJsFindKeys]
])('localization extraction through %s', (_name, extractKeys) => {
  it('preserves cross-file namespaces, source locations and fresh plugin transformations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-extraction-passes-'))
    const file = join(directory, 'a-consumer.ts')
    const config = {
      locales: ['en'],
      extract: {
        input: [join(directory, '*.ts').replaceAll('\\', '/')],
        functions: ['t', '*.t'],
        disablePlurals: true
      }
    }
    try {
      writeFileSync(join(directory, 'z-constants.ts'), "export const NS = 'probe' as const\n")
      const source = [
        "import { NS } from './z-constants'",
        '/* 🙂 */ const { t } = useTranslation(NS);',
        "t('first', 'First')"
      ].join('\n')
      writeFileSync(file, source)
      const first = await extractKeys(config)
      expect([...first.allKeys.values()]).toMatchObject([
        { key: 'first', ns: 'probe', locations: [{ file, line: 3, column: 2 }] }
      ])

      writeFileSync(file, source.replace("'first'", "'updated'"))
      const updated = await extractKeys(config)
      expect([...updated.allKeys.values()].map((entry) => entry.key)).toEqual(['updated'])

      const transformed = await extractKeys({
        ...config,
        plugins: [
          {
            name: 'fixture-transform',
            onLoad: (code) => code.replace("'updated'", "'transformed'")
          }
        ]
      })
      expect([...transformed.allKeys.values()].map((entry) => entry.key)).toEqual(['transformed'])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
