import { describe, expect, it } from 'vitest'
import { lspUriToNativePath, nativePathToLspUri, normalizeNativeFilePath } from './uri-mapping'

describe('nativePathToLspUri / lspUriToNativePath', () => {
  it('round-trips plain Windows paths', () => {
    const uri = nativePathToLspUri('D:\\zwf\\DiligentEngine\\DiligentCore\\Common\\src\\Timer.cpp')
    expect(uri).toBe('file:///D:/zwf/DiligentEngine/DiligentCore/Common/src/Timer.cpp')
    expect(lspUriToNativePath(uri)).toBe(
      'D:\\zwf\\DiligentEngine\\DiligentCore\\Common\\src\\Timer.cpp'
    )
  })

  it('percent-encodes spaces, non-ASCII and #/? while keeping the drive colon', () => {
    const uri = nativePathToLspUri('D:\\a b\\Projé中\\y#z?.cpp')
    expect(uri).toBe('file:///D:/a%20b/Proj%C3%A9%E4%B8%AD/y%23z%3F.cpp')
    expect(lspUriToNativePath(uri)).toBe('D:\\a b\\Projé中\\y#z?.cpp')
  })

  it('restores the uppercase drive from a lowercase-drive URI', () => {
    // `Uri.file().fsPath` hands back lowercase drives; clangd URIs may too.
    expect(lspUriToNativePath('file:///d:/x/y.hpp')).toBe('D:\\x\\y.hpp')
  })

  it('round-trips POSIX absolute paths without a drive', () => {
    const uri = nativePathToLspUri('/home/u/proj/a b/x.cpp')
    expect(uri).toBe('file:///home/u/proj/a%20b/x.cpp')
    expect(lspUriToNativePath(uri)).toBe('/home/u/proj/a b/x.cpp')
  })

  it('rejects non-file URIs', () => {
    expect(() => lspUriToNativePath('untitled:in-memory-1')).toThrow(/not a native file: URI/)
  })

  it('exposes the shared canonical key rule', () => {
    expect(normalizeNativeFilePath('d:/a.cpp')).toBe('D:\\a.cpp')
  })
})
