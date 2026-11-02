/**
 * `buildSshArgs` is shared with the sftp client, and three of its flags mean something else there.
 * Every case below is a silent wrong-target rather than an error if the translation is skipped,
 * which is why the fallback is "refuse and use another transport", never "pass it through".
 */
import { describe, expect, it } from 'vitest'
import {
  SftpArgTranslationError,
  translateSshArgsToSftpArgs,
  withSftpKeepalive
} from './system-ssh-sftp-args'

describe('translateSshArgsToSftpArgs', () => {
  it('sends the port as an option, since sftp -p preserves mtimes instead', () => {
    const args = translateSshArgsToSftpArgs(['-p', '2222', '--', 'dev@win.example'])

    expect(args).toEqual(['-o', 'Port=2222', '--', 'dev@win.example'])
  })

  it('sends the login name as an option, since sftp has no -l', () => {
    // `buildSshArgs` emits `-l` for a config alias no Host block claims. Throwing here would send
    // exactly those hosts to the transport this PR exists to stop using, silently.
    const args = translateSshArgsToSftpArgs(['-l', 'neil', '--', 'awin'])

    expect(args).toEqual(['-o', 'User=neil', '--', 'awin'])
  })

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

  it('spells ControlPath=none out, since sftp -S names a program to run', () => {
    // `sftp -S none` would try to exec a binary called `none`.
    const args = translateSshArgsToSftpArgs(['-S', 'none', '--', 'dev@win.example'])

    expect(args).toEqual(['-o', 'ControlPath=none', '--', 'dev@win.example'])
  })

  it('refuses any other -S, which would hand sftp an ssh binary Orca did not choose', () => {
    expect(() => translateSshArgsToSftpArgs(['-S', '/tmp/ctl.sock'])).toThrow(
      SftpArgTranslationError
    )
  })

  it('drops -T, which sftp does not have', () => {
    expect(translateSshArgsToSftpArgs(['-T', '--', 'host'])).toEqual(['--', 'host'])
  })

  it('passes through the flags both clients spell the same way', () => {
    const args = translateSshArgsToSftpArgs([
      '-F',
      '/tmp/config',
      '-o',
      'BatchMode=yes',
      '-i',
      '/tmp/key',
      '-J',
      'jump.example',
      '--',
      'dev@win.example'
    ])

    expect(args).toEqual([
      '-F',
      '/tmp/config',
      '-o',
      'BatchMode=yes',
      '-i',
      '/tmp/key',
      '-J',
      'jump.example',
      '--',
      'dev@win.example'
    ])
  })

  it('takes everything after -- as the destination without reinterpreting it', () => {
    // A host literally named `-p` is not a flag once `--` has been seen.
    expect(translateSshArgsToSftpArgs(['--', '-p'])).toEqual(['--', '-p'])
  })

  it('refuses an unknown flag rather than guessing what sftp would do with it', () => {
    // The point of the throw: a flag added to buildSshArgs later must degrade to another
    // transport, not reach sftp carrying a different meaning.
    expect(() => translateSshArgsToSftpArgs(['-A', '--', 'host'])).toThrow(SftpArgTranslationError)
  })

  it('refuses a value flag with no value', () => {
    expect(() => translateSshArgsToSftpArgs(['-o'])).toThrow(SftpArgTranslationError)
  })
})

describe('withSftpKeepalive', () => {
  it('asks OpenSSH to notice a dead peer, since the transfer itself has no wall-clock bound', () => {
    expect(withSftpKeepalive(['--', 'host'])).toEqual([
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '--',
      'host'
    ])
  })

  it('leaves a caller-stated keepalive policy alone', () => {
    const args = withSftpKeepalive(['-o', 'ServerAliveInterval=60', '--', 'host'])

    expect(args.filter((arg) => arg.startsWith('ServerAliveInterval'))).toEqual([
      'ServerAliveInterval=60'
    ])
  })
})
