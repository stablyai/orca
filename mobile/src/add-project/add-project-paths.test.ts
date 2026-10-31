import { describe, expect, it } from 'vitest'
import { expandHostHomePath } from './add-project-paths'

describe('expandHostHomePath', () => {
  it('expands ~ against a POSIX home', () => {
    expect(expandHostHomePath('~/orca/projects', '/home/alice')).toBe('/home/alice/orca/projects')
    expect(expandHostHomePath('~', '/home/alice')).toBe('/home/alice')
  })

  it('keeps a Windows home’s separators so stored paths do not mix them', () => {
    expect(expandHostHomePath('~/orca/projects', 'C:\\Users\\alice')).toBe(
      'C:\\Users\\alice\\orca\\projects'
    )
  })

  it('leaves absolute paths, ~user and an unknown home alone', () => {
    expect(expandHostHomePath('/srv/code', '/home/alice')).toBe('/srv/code')
    expect(expandHostHomePath('~bob/code', '/home/alice')).toBe('~bob/code')
    expect(expandHostHomePath('~/code', null)).toBe('~/code')
  })
})
