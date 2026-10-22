import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { loadWindowsSecurity } from '../../shared/windows-security-addon'
import { readRemoteEdgeAuthFile } from './remote-edge-auth-file'

vi.mock('../../shared/windows-security-addon', () => ({ loadWindowsSecurity: vi.fn() }))
const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('refuses Windows credential files when native permission verification is unavailable', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.mocked(loadWindowsSecurity).mockReturnValue({ error: 'synthetic addon failure' })
  const directory = mkdtempSync(join(tmpdir(), 'orca-edge-windows-'))
  directories.push(directory)
  const file = join(directory, 'credentials.json')
  writeFileSync(
    file,
    JSON.stringify({
      v: 1,
      origin: 'wss://orca.example',
      hostPublicKeyB64: 'synthetic-key',
      headers: [{ name: 'CF-Access-Client-Secret', value: 'synthetic-secret' }]
    })
  )
  expect(() =>
    readRemoteEdgeAuthFile(file, {
      endpoint: 'wss://orca.example',
      hostPublicKeyB64: 'synthetic-key',
      credential: { kind: 'token', deviceToken: 'synthetic-device' }
    })
  ).toThrow('Invalid remote edge authentication file')
})
