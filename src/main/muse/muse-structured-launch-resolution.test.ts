import { describe, expect, it } from 'vitest'
import {
  resolveMuseCommand,
  supportsMuseStructuredVersion
} from './muse-structured-launch-resolution'

describe('supportsMuseStructuredVersion', () => {
  it('accepts 1.4 releases', () => {
    expect(supportsMuseStructuredVersion('Muse Code 1.4.10 (1.4.10-R6427.1)')).toBe(true)
    expect(supportsMuseStructuredVersion('1.4.0')).toBe(true)
    expect(supportsMuseStructuredVersion('2.0.1')).toBe(true)
  })

  it('rejects older and unparseable releases', () => {
    expect(supportsMuseStructuredVersion('Muse Code 1.3.9')).toBe(false)
    expect(supportsMuseStructuredVersion('0.9.0')).toBe(false)
    expect(supportsMuseStructuredVersion('not a version')).toBe(false)
  })
})

describe('resolveMuseCommand', () => {
  it('resolves the muse binary from PATH', () => {
    const command = resolveMuseCommand({ PATH: process.env.PATH ?? '' })
    expect(command).toMatch(/muse/)
  })
})
