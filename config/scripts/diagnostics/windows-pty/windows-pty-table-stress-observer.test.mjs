import { describe, expect, it } from 'vitest'
import { sanitizeStressText } from './windows-pty-table-stress-observer.mjs'

describe('Windows PTY stress observer', () => {
  it('redacts a key interrupted by adjacent controls without moving their bytes', () => {
    const esc = String.fromCharCode(27)
    const before = 'sk-secret01'
    const after = '234567890abcdefghijkl'
    const controls = `${esc}[31m${esc}[1m`
    const raw = `${before}${controls}${after}`
    const sanitized = sanitizeStressText(raw)
    expect(sanitized).not.toContain(before)
    expect(sanitized).not.toContain(after)
    expect(sanitized.slice(before.length, before.length + controls.length)).toBe(controls)
    expect(sanitized.length).toBe(raw.length)
  })

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
