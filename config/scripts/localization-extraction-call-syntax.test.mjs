import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findKeys } from 'i18next-cli'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const commonJsFindKeys = require('i18next-cli').findKeys

const calls = {
  normal: "translate('probe.normal', 'Normal')",
  block: "translate /* comment */ ('probe.block', 'Block')",
  line: "translate\n// comment\n('probe.line', 'Line')",
  member: "i18n./* member */t /* call */ ('probe.member', 'Member')",
  optional: "translate?. /* optional */ ('probe.optional', 'Optional')",
  generic: "translate /* generic */ <string>('probe.generic', 'Generic')",
  dollar: "$api.t /* member */ ('probe.dollar', 'Dollar')",
  unicode: "transl\\u0061te('probe.unicode', 'Unicode')"
}

describe.each([
  ['ES module', findKeys],
  ['CommonJS', commonJsFindKeys]
])('localization extraction through %s', (_name, extractKeys) => {
  it('keeps keys in calls containing comments or escaped identifiers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-extraction-syntax-'))
    try {
      for (const [name, source] of Object.entries(calls)) {
        writeFileSync(join(directory, `${name}.ts`), source)
      }
      const errors = []
      const result = await extractKeys(
        {
          locales: ['en'],
          extract: {
            input: [join(directory, '*.ts').replaceAll('\\', '/')],
            defaultNS: false,
            functions: ['t', '*.t', 'translate'],
            disablePlurals: true
          }
        },
        undefined,
        errors
      )
      expect(errors).toEqual([])
      expect([...result.allKeys.values()].map((entry) => entry.key).sort()).toEqual(
        Object.keys(calls)
          .map((name) => `probe.${name}`)
          .sort()
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
