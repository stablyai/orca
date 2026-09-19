import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRelayLaunchOptions, readRelayEndpointCredential } from './relay-launch-options'

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
        '--enable-ownership-transfer-mutation',
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
      enableOwnershipTransferMutation: true,
      enableDelegatedOwnershipCapture: false,
      enableSourceDeliveryRetirement: false,
      sockPath: 'relay-endpoint',
      endpointDir: 'hooks',
      logFile: 'relay.log',
      credentialFile: 'relay.credential'
    })
  })

  it('keeps zero grace unlimited and ignores invalid replacements', () => {
    expect(
      parseRelayLaunchOptions(['node', 'relay.js', '--grace-time', '0', '--grace-time', '-1'])
        .graceTimeMs
    ).toBe(0)
  })

  it('requires both explicit launch flags for delegated capture', () => {
    for (const flags of [
      [],
      ['--enable-delegated-ownership-capture'],
      ['--enable-ownership-transfer-mutation']
    ]) {
      expect(
        parseRelayLaunchOptions(['node', 'relay.js', ...flags]).enableDelegatedOwnershipCapture
      ).toBe(false)
    }
    expect(
      parseRelayLaunchOptions([
        'node',
        'relay.js',
        '--enable-ownership-transfer-mutation',
        '--enable-delegated-ownership-capture'
      ]).enableDelegatedOwnershipCapture
    ).toBe(true)
  })

  it('keeps ownership-transfer mutation disabled unless explicitly requested', () => {
    expect(parseRelayLaunchOptions(['node', 'relay.js']).enableOwnershipTransferMutation).toBe(
      false
    )
  })

  it.each(Array.from({ length: 8 }, (_, mask) => mask))(
    'requires all three launch opt-ins for source delivery retirement (mask %s)',
    (mask) => {
      const flags = [
        '--enable-ownership-transfer-mutation',
        '--enable-delegated-ownership-capture',
        '--enable-source-delivery-retirement'
      ].filter((_, index) => (mask & (1 << index)) !== 0)
      expect(
        parseRelayLaunchOptions(['bun', 'relay.js', ...flags]).enableSourceDeliveryRetirement
      ).toBe(mask === 7)
    }
  )

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
