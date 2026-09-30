import { describe, expect, it } from 'vitest'
import { redactString } from './redactor'

const originalEnvLine = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*\S.*/gm
const original = (input: string): string =>
  input.replace(originalEnvLine, (_match, key) => `${String(key)}=[redacted:env-value]`)

const whitespace = [
  ' ',
  '\t',
  '\n',
  '\r',
  '\r\n',
  '\u2028',
  '\u2029',
  '\v',
  '\f',
  '\u00a0',
  '\ufeff'
]

describe('environment line redaction parity', () => {
  it.each(whitespace)('preserves cross-line greedy whitespace for %j', (space) => {
    for (const source of [
      `${space}${space}FOO${space}=${space}value${space}BAR=next`,
      `FOO=${space}${space}`,
      `${space}${space}not-a-key${space}FOO=value`,
      `FOO${space}${space}BAR=value`,
      `FOO=${space}BAR=next`,
      `${space}FOO=one${space}${space}BAR=two${space}`,
      `not a key${space}${space}FOO=one`,
      `${space}FOO=${space}${space}lowercase`,
      `${space}FOO=${space} BAR=next${space}tail`
    ]) {
      expect(redactString(source), JSON.stringify(source)).toBe(original(source))
    }
  })

  it('matches the original across 20,000 malformed and valid sequences', () => {
    const tokens = [...whitespace, 'FOO', '_A12', 'lowercase', '!', '=', '==', 'value', '0', 'FOO=']
    let seed = 173
    for (let sample = 0; sample < 20000; sample++) {
      let source = ''
      for (let token = 0; token < 18; token++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        source += tokens[seed % tokens.length]
      }
      expect(redactString(source), JSON.stringify(source)).toBe(original(source))
    }
  })

  it('keeps rule ordering for labeled secrets within environment values', () => {
    expect(redactString('\n\r\nFOO=token: value\nBAR=other')).toBe(
      'FOO=[redacted:env-value]\nBAR=[redacted:env-value]'
    )
  })

  it('does not retry every blank line before an invalid key', () => {
    const source = `${'\r\n\u2028\u2029'.repeat(16384)}lowercase`
    const started = performance.now()
    expect(redactString(source)).toBe(source)
    expect(performance.now() - started).toBeLessThan(200)
  })
})
