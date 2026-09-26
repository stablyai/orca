/**
 * Both functions here guard against the same measured failure: sftp's batch lexer treats `\` as an
 * escape, so a Windows path handed over raw is silently mis-targeted *and the client still exits
 * 0*. On Windows 11 / OpenSSH 10.0p2, `put src C:\Users\neil\qt\a.bin` created a file literally
 * named `C` in the start directory and reported success.
 */
import { describe, expect, it } from 'vitest'
import {
  quoteSftpBatchArgument,
  toSftpRemotePath,
  UnsupportedSftpPathError
} from './system-ssh-sftp-path'

describe('toSftpRemotePath', () => {
  it('roots a drive path under /, which is the namespace the Windows sftp-server exposes', () => {
    // `pwd` in that session reports `/C:/Users/dev`.
    expect(toSftpRemotePath('C:/Users/dev/f.bin')).toBe('/C:/Users/dev/f.bin')
  })

  it('accepts a path already in that namespace unchanged', () => {
    expect(toSftpRemotePath('/C:/Users/dev/f.bin')).toBe('/C:/Users/dev/f.bin')
  })

  it('converts the separators Orca stores paths with', () => {
    expect(toSftpRemotePath('C:\\Users\\dev\\f.bin')).toBe('/C:/Users/dev/f.bin')
  })

  it('declines a UNC path rather than guessing where it lands', () => {
    // A guess here writes real bytes to the wrong place; declining falls back to another transport.
    expect(() => toSftpRemotePath('//server/share/f.bin')).toThrow(UnsupportedSftpPathError)
  })

  it('declines a relative path, which would resolve against the session start directory', () => {
    expect(() => toSftpRemotePath('Users/dev/f.bin')).toThrow(UnsupportedSftpPathError)
  })
})

describe('quoteSftpBatchArgument', () => {
  it('escapes the backslashes in a Windows client local path', () => {
    // Unescaped, sftp reads this as C:srcf.bin and fails to find the source.
    expect(quoteSftpBatchArgument('C:\\src\\f.bin')).toBe('"C:\\\\src\\\\f.bin"')
  })

  it('keeps a path with spaces as one argument', () => {
    expect(quoteSftpBatchArgument('/tmp/two words.bin')).toBe('"/tmp/two words.bin"')
  })

  it('escapes an embedded quote, which would otherwise end the argument early', () => {
    expect(quoteSftpBatchArgument('/tmp/dq".bin')).toBe('"/tmp/dq\\".bin"')
  })

  it('refuses a line break, which would split one batch command into two', () => {
    expect(() => quoteSftpBatchArgument('/tmp/a\nrm -rf b')).toThrow(UnsupportedSftpPathError)
  })

  it('refuses a NUL, which truncates the argument', () => {
    expect(() => quoteSftpBatchArgument('/tmp/a\0b')).toThrow(UnsupportedSftpPathError)
  })
})
