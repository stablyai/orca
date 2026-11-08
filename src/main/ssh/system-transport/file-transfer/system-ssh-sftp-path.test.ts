/** Windows 11/OpenSSH 10.0p2: unescaped backslashes can write a file named C and still exit 0. */
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

  it('declines a UNC path rather than guessing where it lands', () => {
    // A guess here writes real bytes to the wrong place; declining falls back to another transport.
    expect(() => toSftpRemotePath('//server/share/f.bin')).toThrow(UnsupportedSftpPathError)
  })
})

describe('quoteSftpBatchArgument', () => {
  it('escapes the backslashes in a Windows client local path', () => {
    // Unescaped, sftp reads this as C:srcf.bin and fails to find the source.
    expect(quoteSftpBatchArgument('C:\\src\\f.bin')).toBe('"C:\\\\src\\\\f.bin"')
  })

  it('escapes an embedded quote, which would otherwise end the argument early', () => {
    expect(quoteSftpBatchArgument('/tmp/dq".bin')).toBe('"/tmp/dq\\".bin"')
  })

  it('refuses a line break, which would split one batch command into two', () => {
    expect(() => quoteSftpBatchArgument('/tmp/a\nrm -rf b')).toThrow(UnsupportedSftpPathError)
  })
})
