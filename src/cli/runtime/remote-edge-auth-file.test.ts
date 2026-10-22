import { removeTree } from '../../shared/windows-transient-lock-removal'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import { generateKeyPair, publicKeyToBase64 } from '../../shared/e2ee-crypto'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import { writeSecureFile } from '../../shared/secure-file'
import { addEnvironmentFromPairingCode } from './environments'
import { resolveRemoteConnection } from './runtime-remote-pairing'
import { readRemoteEdgeAuthFile } from './remote-edge-auth-file'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const dir of directories.splice(0)) {
    await removeTree(dir)
  }
})
const paired: PairedRuntimeConnection = {
  endpoint: 'wss://orca.example/proxy?route=synthetic',
  hostPublicKeyB64: publicKeyToBase64(generateKeyPair().publicKey),
  credential: { kind: 'token', deviceToken: 'synthetic-device' }
}
const bundle = () => ({
  v: 1,
  origin: 'wss://orca.example',
  hostPublicKeyB64: paired.hostPublicKeyB64,
  headers: [{ name: 'CF-Access-Client-Secret', value: 'synthetic-secret' }]
})
function fixture(contents = JSON.stringify(bundle())) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-edge-file-'))
  directories.push(dir)
  const path = join(dir, 'credentials.json')
  writeSecureFile(path, contents)
  return { dir, path }
}

describe('CLI private edge credential input', () => {
  it('reads a bound private file without rewriting it', () => {
    const { path } = fixture()
    const before = readFileSync(path)
    expect(readRemoteEdgeAuthFile(path, paired)).toEqual({
      origin: 'wss://orca.example',
      hostPublicKeyB64: paired.hostPublicKeyB64,
      headers: { 'CF-Access-Client-Secret': 'synthetic-secret' }
    })
    expect(readFileSync(path)).toEqual(before)
  })

  it.each(['origin', 'key', 'empty', 'malformed', 'oversized', 'directory', 'insecure'] as const)(
    'refuses %s input without exposing contents',
    (kind) => {
      const data = bundle()
      if (kind === 'origin') {
        data.origin = 'wss://other.example'
      }
      if (kind === 'key') {
        data.hostPublicKeyB64 = 'other-key'
      }
      if (kind === 'empty') {
        data.headers = []
      }
      const { path, dir } = fixture(
        kind === 'malformed'
          ? 'synthetic-secret{'
          : kind === 'oversized'
            ? 'synthetic-secret'.repeat(3000)
            : JSON.stringify(data)
      )
      expect(() =>
        readRemoteEdgeAuthFile(
          kind === 'directory' ? dir : path,
          kind === 'insecure' ? { ...paired, endpoint: 'ws://orca.example' } : paired
        )
      ).toThrow('Invalid remote edge authentication file')
      try {
        readRemoteEdgeAuthFile(path, { ...paired, hostPublicKeyB64: 'wrong' })
      } catch (error) {
        expect(String(error)).not.toContain('synthetic-secret')
      }
    }
  )

  it.skipIf(process.platform === 'win32')('refuses files readable by another user', () => {
    const { path } = fixture()
    chmodSync(path, 0o644)
    expect(() => readRemoteEdgeAuthFile(path, paired)).toThrow(
      'Invalid remote edge authentication file'
    )
  })

  it.each(['pairing code', 'saved environment'])(
    'attaches the selected file for a %s and reads rotation on a new invocation',
    (mode) => {
      const { path, dir } = fixture()
      vi.stubEnv('ORCA_REMOTE_AUTH_FILE', path)
      const code = encodePairingOffer({
        v: 2,
        endpoint: paired.endpoint,
        deviceToken: 'synthetic-device',
        publicKeyB64: paired.hostPublicKeyB64
      })
      if (mode === 'saved environment') {
        addEnvironmentFromPairingCode(dir, { name: 'edge-server', pairingCode: code })
      }
      const resolve = () =>
        resolveRemoteConnection(
          dir,
          mode === 'pairing code' ? code : null,
          mode === 'saved environment' ? 'edge-server' : null
        )
      expect(resolve()?.edgeAuth?.headers['CF-Access-Client-Secret']).toBe('synthetic-secret')
      const updated = bundle()
      updated.headers[0]!.value = 'rotated-secret'
      writeFileSync(path, JSON.stringify(updated))
      expect(resolve()?.edgeAuth?.headers['CF-Access-Client-Secret']).toBe('rotated-secret')
      expect(JSON.stringify(resolve())).not.toContain('credentials.json')
    }
  )

  it('preserves the ordinary connection when the variable is absent', () => {
    vi.stubEnv('ORCA_REMOTE_AUTH_FILE', '')
    const code = encodePairingOffer({
      v: 2,
      endpoint: paired.endpoint,
      deviceToken: 'synthetic-device',
      publicKeyB64: paired.hostPublicKeyB64
    })
    expect(resolveRemoteConnection('/unused', code, null)?.edgeAuth).toBeUndefined()
  })
})
