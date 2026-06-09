import { homedir } from 'os'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { expandTilde } from './context'

describe('expandTilde', () => {
  it('expands POSIX-style home paths', () => {
    expect(expandTilde('~/projects')).toBe(resolve(homedir(), 'projects'))
  })

  it('expands Windows-style home paths without forcing POSIX separators', () => {
    expect(expandTilde('~\\projects')).toBe(`${homedir()}\\projects`)
  })
})
