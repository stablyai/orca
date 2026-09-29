import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  detachedRelayArguments,
  parseRelayLaunchOptions,
  readRelayEndpointCredential
} from './relay-launch-options'

describe('relay launch options', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    )
  })

  it('preserves daemon mode flags and grace seconds conversion', () => {
    expect(
      parseRelayLaunchOptions([
        'node',
        'relay.js',
        '--detached',
        '--connect',
        '--grace-time',
        '17',
        '--sock-path',
        'relay-endpoint',
        '--endpoint-dir',
        'hooks',
        '--log-file',
        'relay.log',
        '--credential-file',
        'relay.credential'
      ])
    ).toEqual({
      graceTimeMs: 17_000,
      connectMode: true,
      detached: true,
      cliMode: false,
      spawnDetachedMode: false,
      launchErrorFile: undefined,
      ripgrepPath: undefined,
      sockPath: 'relay-endpoint',
      endpointDir: 'hooks',
      logFile: 'relay.log',
      credentialFile: 'relay.credential'
    })
  })

  it('forwards launch values as argv without recursive launch or shell expansion', () => {
    const options = parseRelayLaunchOptions([
      'bun',
      'relay.js',
      '--spawn-detached',
      '--grace-time',
      '0',
      '--sock-path',
      '--spawn-detached',
      '--credential-file',
      'C:\\a & %USER%\\credential',
      '--log-file',
      'C:\\logs with spaces\\out.log',
      '--launch-error-file',
      'err.log'
    ])
    const args = detachedRelayArguments('C:\\relay root\\relay.js', options)
    expect(args).toEqual([
      '--no-env-file',
      '--config=NUL',
      '--no-install',
      'C:\\relay root\\relay.js',
      '--detached',
      '--grace-time',
      '0',
      '--sock-path',
      '--spawn-detached',
      '--log-file',
      'C:\\logs with spaces\\out.log',
      '--credential-file',
      'C:\\a & %USER%\\credential'
    ])
    const reparsed = parseRelayLaunchOptions(['bun', ...args.slice(3)])
    expect(reparsed.spawnDetachedMode).toBe(false)
    expect(reparsed.sockPath).toBe('--spawn-detached')
    expect(reparsed.launchErrorFile).toBeUndefined()
  })

  it('preserves every daemon option across the detached launcher', () => {
    const options = parseRelayLaunchOptions([
      'bun',
      'relay.js',
      '--spawn-detached',
      '--grace-time',
      '123',
      '--sock-path',
      'pipe-name',
      '--endpoint-dir',
      'C:/hooks & tools',
      '--credential-file',
      'C:/秘密/credential',
      '--log-file',
      'C:/logs/relay.log',
      '--launch-error-file',
      'C:/logs/relay.err.log',
      '--ripgrep-path',
      'C:/tools/rg.exe'
    ])
    const args = detachedRelayArguments('C:/relay/relay.js', options)
    expect(parseRelayLaunchOptions(['bun', ...args.slice(3)])).toEqual({
      ...options,
      detached: true,
      spawnDetachedMode: false,
      launchErrorFile: undefined
    })
  })

  it('reads the bundled ripgrep path, which older launch commands omit', () => {
    expect(
      parseRelayLaunchOptions([
        'node',
        'relay.js',
        '--detached',
        '--ripgrep-path',
        '/home/me/.orca-remote/ripgrep/c0ffee0123456789-linux-x64/rg'
      ]).ripgrepPath
    ).toBe('/home/me/.orca-remote/ripgrep/c0ffee0123456789-linux-x64/rg')
    expect(parseRelayLaunchOptions(['node', 'relay.js', '--detached']).ripgrepPath).toBe(undefined)
  })

  it('keeps zero grace unlimited and ignores invalid replacements', () => {
    expect(
      parseRelayLaunchOptions(['node', 'relay.js', '--grace-time', '0', '--grace-time', '-1'])
        .graceTimeMs
    ).toBe(0)
  })

  it('validates and restricts the endpoint credential file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-launch-options-'))
    temporaryDirectories.push(directory)
    const credentialFile = join(directory, 'endpoint.credential')
    const credential = 'a'.repeat(32)
    writeFileSync(credentialFile, `${credential}\n`)
    if (process.platform !== 'win32') {
      chmodSync(credentialFile, 0o644)
    }

    expect(readRelayEndpointCredential(credentialFile)).toBe(credential)
    if (process.platform !== 'win32') {
      expect(statSync(credentialFile).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects credentials that cannot authenticate a reconnect client', () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-launch-options-'))
    temporaryDirectories.push(directory)
    const credentialFile = join(directory, 'endpoint.credential')
    writeFileSync(credentialFile, 'too-short')

    expect(() => readRelayEndpointCredential(credentialFile)).toThrow(
      'Relay endpoint credential is missing or invalid'
    )
  })
})
