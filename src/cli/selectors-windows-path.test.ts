import { describe, expect, it } from 'vitest'
import { normalizeWorktreeSelector } from './selectors'

describe('normalizeWorktreeSelector Windows path: (#12303)', () => {
  it('folds drive-letter backslashes to forward slashes', () => {
    expect(
      normalizeWorktreeSelector(
        'path:D:\\work\\orgs\\KT\\ops\\windows-captain\\demo-product',
        'C:\\Users\\me'
      )
    ).toBe('path:D:/work/orgs/KT/ops/windows-captain/demo-product')
  })

  it('leaves already-forward Windows paths unchanged', () => {
    expect(normalizeWorktreeSelector('path:D:/work/orgs/demo-product', 'C:\\Users\\me')).toBe(
      'path:D:/work/orgs/demo-product'
    )
  })

  it('does not rewrite POSIX paths that contain backslash characters', () => {
    expect(normalizeWorktreeSelector('path:/srv/team\\repo', '/tmp')).toBe('path:/srv/team\\repo')
  })

  it('leaves branch/name selectors alone', () => {
    expect(normalizeWorktreeSelector('branch:feature/foo', '/tmp')).toBe('branch:feature/foo')
  })
})
