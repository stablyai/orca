import { describe, expect, it } from 'vitest'
import { canonicalFileUriKey } from './lsp-file-uri-key'

describe('canonicalFileUriKey', () => {
  it('maps Node and vscode-uri forms of the same Windows path to one key', () => {
    expect(canonicalFileUriKey('file:///C:/dev/repo/a.ts')).toBe(
      canonicalFileUriKey('file:///c%3A/dev/repo/a.ts')
    )
  })

  it('folds percent-encoding differences on posix paths', () => {
    expect(canonicalFileUriKey('file:///Users/dev/my%20project/a.ts')).toBe(
      canonicalFileUriKey('file:///Users/dev/my project/a.ts')
    )
  })

  it('keeps distinct paths distinct and survives malformed encodings', () => {
    expect(canonicalFileUriKey('file:///a/b.ts')).not.toBe(canonicalFileUriKey('file:///a/c.ts'))
    expect(canonicalFileUriKey('file:///a/%zz')).toBe('file:///a/%zz')
  })
})
