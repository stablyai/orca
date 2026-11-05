import { describe, expect, it } from 'vitest'
import { checkBunVersion } from './pinned-bun-executable.mjs'

describe('checkBunVersion', () => {
  it('refuses an older Bun and says how to get the pinned one', () => {
    const result = checkBunVersion('1.3.14', '1.4.3')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Bun 1.3.14 is older than the pinned 1.4.3')
    expect(result.message).toContain('pnpm install')
  })

  it('compares each part as a number', () => {
    expect(checkBunVersion('1.9.0', '1.10.0').ok).toBe(false)
    expect(checkBunVersion('1.10.0', '1.9.0')).toEqual({ ok: true })
  })

  it('passes an equal or newer Bun', () => {
    expect(checkBunVersion('1.4.3', '1.4.3')).toEqual({ ok: true })
    expect(checkBunVersion('1.4.4', '1.4.3')).toEqual({ ok: true })
    expect(checkBunVersion('2.0.0', '1.4.3')).toEqual({ ok: true })
  })

  it('warns and continues when a version cannot be read', () => {
    for (const found of [null, '', 'bun: command not found', '1.4']) {
      const result = checkBunVersion(found, '1.4.3')
      expect(result.ok).toBe(true)
      expect(result.message).toContain('Could not read the Bun version')
    }
  })
})
