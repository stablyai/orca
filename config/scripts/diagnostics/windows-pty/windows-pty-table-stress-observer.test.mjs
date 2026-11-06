import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { sanitizeStressText } from './windows-pty-table-stress-observer.mjs'

const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Windows PTY stress observer', () => {
  it('preserves OSC boundaries while redacting their title payload and adjacent CSI text', () => {
    const esc = String.fromCharCode(27)
    const raw = `${esc}]0;private@sensitive.test${esc}\\${esc}[31mprivate@sensitive.test`
    const sanitized = sanitizeStressText(raw)
    expect(sanitized).not.toContain('private@')
    expect(sanitized).not.toContain('sensitive.test')
    expect(sanitized).toContain(`${esc}]0;`)
    expect(sanitized).toContain(`${esc}\\${esc}[31m`)
    expect(sanitized.length).toBe(raw.length)
  })

  it.each([
    ['email domain', 'private@', 'sensitive.test', ['[31m']],
    ['email name', 'pri', 'vate@sensitive.test', ['[31m', '[1m']],
    ['vendor key', 'sk-secret01', '234567890abcdefghijkl', ['[31m', '[1m']],
    ['bearer token', 'Bearer secret01', '234567890abcdefghijkl', ['[31m', '[1m']]
  ])(
    'redacts %s interrupted by adjacent controls without moving their bytes',
    (_kind, before, after, fragments) => {
      const esc = String.fromCharCode(27)
      const controls = fragments.map((fragment) => esc + fragment).join('')
      const raw = `${before}${controls}${after}`
      const sanitized = sanitizeStressText(raw)
      expect(sanitized).not.toContain(before)
      expect(sanitized).not.toContain(after)
      expect(sanitized.slice(before.length, before.length + controls.length)).toBe(controls)
      expect(sanitized.length).toBe(raw.length)
    }
  )

  it('scrubs an interrupted OSC title independently from the adjacent rendered address', () => {
    const esc = String.fromCharCode(27)
    const title = `private@${esc}[31msensitive.test`
    const raw = `${esc}]0;${title}${esc}\\private@sensitive.test`
    const sanitized = sanitizeStressText(raw)
    expect(sanitized).not.toContain('private@')
    expect(sanitized).not.toContain('sensitive.test')
    expect(sanitized.slice(0, 4)).toBe(`${esc}]0;`)
    expect(sanitized.slice(12, 17)).toBe(`${esc}[31m`)
    expect(sanitized.slice(4 + title.length, 6 + title.length)).toBe(`${esc}\\`)
    expect(sanitized.length).toBe(raw.length)
  })
})
