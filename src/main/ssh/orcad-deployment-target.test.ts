import { describe, expect, it } from 'vitest'
import { parseOrcadLinuxLibc } from './orcad-deployment-target'

describe('deployment C library selection', () => {
  it.each([
    ['ldd (Ubuntu GLIBC 2.31-0ubuntu9) 2.31', 'glibc'],
    ['ldd (GNU libc) 2.28', 'glibc'],
    ['musl libc (x86_64)\nVersion 1.2.5', 'musl']
  ])('recognizes %s', (output, expected) => {
    expect(parseOrcadLinuxLibc(output)).toBe(expected)
  })

  it.each(['', 'ldd: command not found', 'Linux x86_64'])(
    'refuses unproven target %j',
    (output) => {
      expect(() => parseOrcadLinuxLibc(output)).toThrow('Could not identify')
    }
  )
})
