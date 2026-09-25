import { describe, expect, it } from 'vitest'
import { wslNormalizeKey, wslPathToLspUri, wslLspUriToPath, isWslUncPath } from './wsl-path-mapping'

// UNC paths use backslashes on Windows; the test source doubles them so the
// JS string holds one backslash per pair.
const UNC = String.raw

describe('wslPathToLspUri / wslLspUriToPath — UNC ⇄ guest round trip (spec D5/D8)', () => {
  it('maps a UNC path to the guest file: URI and back', () => {
    const uri = wslPathToLspUri(UNC`\\wsl.localhost\Ubuntu\home\u\repo\src\main.cpp`)
    expect(uri).toBe('file:///home/u/repo/src/main.cpp')
    expect(wslLspUriToPath(uri, 'Ubuntu')).toBe(
      UNC`\\wsl.localhost\Ubuntu\home\u\repo\src\main.cpp`
    )
  })

  it('accepts forward-slash UNC spellings (//wsl.localhost/...)', () => {
    const uri = wslPathToLspUri('//wsl.localhost/Ubuntu/home/u/a.cpp')
    expect(uri).toBe('file:///home/u/a.cpp')
    expect(wslLspUriToPath(uri, 'Ubuntu')).toBe(UNC`\\wsl.localhost\Ubuntu\home\u\a.cpp`)
  })

  it('accepts the legacy \\wsl$\\ share spelling', () => {
    const uri = wslPathToLspUri(UNC`\\wsl$\Ubuntu\home\u\a.cpp`)
    expect(uri).toBe('file:///home/u/a.cpp')
    expect(wslLspUriToPath(uri, 'Ubuntu')).toBe(UNC`\\wsl.localhost\Ubuntu\home\u\a.cpp`)
  })

  it('handles distro names with spaces', () => {
    const uri = wslPathToLspUri(UNC`\\wsl.localhost\Ubuntu 24.04\home\u\a b\x.cpp`)
    expect(uri).toBe('file:///home/u/a%20b/x.cpp')
    expect(wslLspUriToPath(uri, 'Ubuntu 24.04')).toBe(
      UNC`\\wsl.localhost\Ubuntu 24.04\home\u\a b\src.cpp`.replace('src', 'x')
    )
  })

  it('percent-encodes spaces and non-ASCII in the guest path, decodes on return', () => {
    const uri = wslPathToLspUri(UNC`\\wsl.localhost\Debian\home\u\Projé中\y#z.cpp`)
    expect(uri).toBe('file:///home/u/Proj%C3%A9%E4%B8%AD/y%23z.cpp')
    expect(wslLspUriToPath(uri, 'Debian')).toBe(UNC`\\wsl.localhost\Debian\home\u\Projé中\y#z.cpp`)
  })

  it('maps a deep guest path to UNC and back (root-share edge)', () => {
    const uri = wslPathToLspUri(UNC`\\wsl.localhost\Ubuntu\home\u`)
    expect(uri).toBe('file:///home/u')
    expect(wslLspUriToPath(uri, 'Ubuntu')).toBe(UNC`\\wsl.localhost\Ubuntu\home\u`)
  })

  it('maps a drvfs guest URI back to the Windows drive (file sits on the drive)', () => {
    // clangd inside the guest may report /mnt/c/... for a Windows drive file.
    const drivePath = wslLspUriToPath('file:///mnt/c/Users/me/header.hpp', 'Ubuntu')
    expect(drivePath).toBe(String.raw`C:\Users\me\header.hpp`)
  })

  it('rejects non-file URIs', () => {
    expect(() => wslLspUriToPath('untitled:in-memory-1', 'Ubuntu')).toThrow(/not a file: URI/)
  })
})

describe('wslNormalizeKey — case-folds the UNC prefix, keeps the Linux tail', () => {
  it('folds wsl.localhost + distro case-insensitively', () => {
    expect(wslNormalizeKey(UNC`\\wsl.localhost\Ubuntu\home\u\a.cpp`)).toBe(
      wslNormalizeKey(UNC`\\WSL.LOCALHOST\ubuntu\home\u\a.cpp`)
    )
  })

  it('keeps the Linux path tail case-sensitive', () => {
    expect(wslNormalizeKey(UNC`\\wsl.localhost\Ubuntu\Home\u\a.cpp`)).not.toBe(
      wslNormalizeKey(UNC`\\wsl.localhost\Ubuntu\home\u\a.cpp`)
    )
  })

  it('canonicalizes backslash and forward-slash UNC spellings to the same key', () => {
    expect(wslNormalizeKey(UNC`\\wsl.localhost\Ubuntu\home\u\a.cpp`)).toBe(
      wslNormalizeKey('//wsl.localhost/Ubuntu/home/u/a.cpp')
    )
  })

  it('falls back to native drive normalization for non-UNC paths', () => {
    expect(wslNormalizeKey('d:/proj/a.cpp')).toBe(String.raw`D:\proj\a.cpp`)
  })

  it('passes POSIX paths through unchanged', () => {
    expect(wslNormalizeKey('/home/u/a.cpp')).toBe('/home/u/a.cpp')
  })
})

describe('isWslUncPath', () => {
  it('recognizes both wsl.localhost and wsl$ spellings', () => {
    expect(isWslUncPath(UNC`\\wsl.localhost\Ubuntu\home\u\a.cpp`)).toBe(true)
    expect(isWslUncPath(UNC`\\wsl$\Ubuntu\home\u\a.cpp`)).toBe(true)
  })

  it('rejects drive and POSIX paths', () => {
    expect(isWslUncPath(String.raw`D:\repo\a.cpp`)).toBe(false)
    expect(isWslUncPath('/home/u/a.cpp')).toBe(false)
  })
})
