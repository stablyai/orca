import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { findDuplicateTomlDeclarations } from '../../configuration/toml/config-toml-duplicate-declarations-test-fixture'
import { parseTomlStringValue } from '../../configuration/toml/config-toml-line-scan'
import { upsertProjectTrustContent } from './config-toml-project-trust'
import { upsertHookTrustEntries } from './config-toml-trust'
import {
  createTrustConfigFixture,
  removeTrustConfigFixture
} from './config-toml-trust-test-fixtures'

// Regression for #40071: multiline strings may end with up to two quotes that
// belong to the value, ahead of the three closing delimiters.
const PROJECT = '/tmp/orca-toml-repro'
const HOOK_KEY = '/x/hooks.json:pre_tool_use:0:0'
const MULTILINE_ARGS_CASES = [
  { label: "literal ''' with one trailing quote", argsLine: `args = ["-c", '''printf 'ok'''']` },
  { label: "literal ''' with two trailing quotes", argsLine: `args = ["-c", '''printf ''ok''''']` },
  { label: 'basic """ with one trailing quote', argsLine: `args = ["-c", """printf "ok"""" ]` },
  { label: 'basic """ with two trailing quotes', argsLine: `args = ["-c", """printf ""ok""""" ]` }
]

let tmpDir: string
let configPath: string

beforeEach(() => {
  const fixture = createTrustConfigFixture()
  tmpDir = fixture.tmpDir
  configPath = fixture.configPath
})

afterEach(() => {
  removeTrustConfigFixture(tmpDir)
})

describe('trust writes recognize tables after multiline strings ending in quote runs', () => {
  it.each(MULTILINE_ARGS_CASES)(
    're-trusting the existing project table leaves $label untouched',
    ({ argsLine }) => {
      const original = [
        '[mcp_servers.repro]',
        'command = "sh"',
        argsLine,
        '',
        `[projects."${PROJECT}"]`,
        'trust_level = "trusted"',
        ''
      ].join('\n')

      const updated = upsertProjectTrustContent(original, PROJECT, 'trusted', {
        alreadyCanonical: true
      })

      expect(updated).toBe(original)
      expect(findDuplicateTomlDeclarations(updated)).toEqual([])
    }
  )

  it.each(MULTILINE_ARGS_CASES)(
    're-trusting the existing hook state table appends nothing after $label',
    ({ argsLine }) => {
      const original = [
        '[mcp_servers.repro]',
        'command = "sh"',
        argsLine,
        '',
        `[hooks.state."${HOOK_KEY}"]`,
        'enabled = true',
        'trusted_hash = "sha256:OLD"',
        ''
      ].join('\n')
      writeFileSync(configPath, original, 'utf-8')

      upsertHookTrustEntries(configPath, [
        {
          sourcePath: '/x/hooks.json',
          eventLabel: 'pre_tool_use',
          groupIndex: 0,
          handlerIndex: 0,
          command: 'echo'
        }
      ])

      const written = readFileSync(configPath, 'utf-8')
      expect(written.match(/\[hooks\.state/g)).toHaveLength(1)
      expect(written).toContain(argsLine)
      expect(written).not.toContain('sha256:OLD')
      expect(findDuplicateTomlDeclarations(written)).toEqual([])
    }
  )

  it('parses the value of a multiline literal string with a trailing quote', () => {
    const line = `args = ["-c", '''printf 'ok'''']`
    const valueOffset = line.indexOf("'''")

    const parsed = parseTomlStringValue(line, valueOffset)

    expect(parsed?.value).toBe("printf 'ok'")
    expect(parsed?.end).toBe(line.length - 1)
  })
})
