/** SSH flags can silently change meaning in SFTP; unknown translations must decline to another transport. */
import { describe, expect, it } from 'vitest'
import { translateSshArgsToSftpArgs } from './system-ssh-sftp-args'

describe('translateSshArgsToSftpArgs', () => {
  it('translates the whole unclaimed-alias shape buildSshArgs emits', () => {
    const args = translateSshArgsToSftpArgs([
      '-o',
      'BatchMode=no',
      '-T',
      '-S',
      'none',
      '-o',
      'Hostname=192.168.0.186',
      '-p',
      '2222',
      '-l',
      'neil',
      '--',
      'awin'
    ])

    expect(args).toEqual([
      '-o',
      'BatchMode=no',
      '-o',
      'ControlPath=none',
      '-o',
      'Hostname=192.168.0.186',
      '-o',
      'Port=2222',
      '-o',
      'User=neil',
      '--',
      'awin'
    ])
  })
})
