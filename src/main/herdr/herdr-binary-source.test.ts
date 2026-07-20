import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveHerdrBinarySource,
  resolveLocalHerdrExecutable,
  verifyManagedHerdrExecutable
} from './herdr-binary-source'

describe('Herdr binary source', () => {
  it('resolves the packaged managed sidecar without falling back to PATH', () => {
    expect(
      resolveLocalHerdrExecutable({
        source: { kind: 'managed' },
        isPackaged: true,
        resourcesPath: '/Applications/Orca.app/Contents/Resources',
        platform: 'darwin',
        arch: 'arm64'
      })
    ).toBe('/Applications/Orca.app/Contents/Resources/herdr/darwin-arm64/herdr')
  })

  it('uses a host override before the global source', () => {
    expect(
      resolveHerdrBinarySource(
        {
          herdrBinarySource: { kind: 'managed' },
          hostSettingOverrides: {
            'ssh:server-1': { herdrBinarySource: { kind: 'custom', path: '/opt/herdr' } }
          }
        },
        'ssh:server-1'
      )
    ).toEqual({ kind: 'custom', path: '/opt/herdr' })
  })

  it('accepts only a licensed, capability-compatible, checksum-matched sidecar', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-herdr-'))
    try {
      const executable = join(directory, 'herdr')
      const bytes = Buffer.from('verified-herdr')
      writeFileSync(executable, bytes)
      chmodSync(executable, 0o755)
      writeFileSync(join(directory, 'LICENSE'), 'AGPL-3.0-or-later')
      writeFileSync(
        join(directory, 'manifest.json'),
        JSON.stringify({
          version: '0.7.4',
          sourceCommit: 'abc123',
          sourceUrl: 'https://github.com/ogulcancelik/herdr',
          protocol: 17,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          capabilities: {
            external_refs: true,
            resumable_events: true,
            portable_layouts: true,
            terminal_control_v2: true,
            terminal_history: true,
            controller_takeover: true
          }
        })
      )

      expect(verifyManagedHerdrExecutable(executable).sourceCommit).toBe('abc123')
      const manifestPath = join(directory, 'manifest.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      delete manifest.protocol
      writeFileSync(manifestPath, JSON.stringify(manifest))
      expect(() => verifyManagedHerdrExecutable(executable)).toThrow(
        'manifest identity or protocol is invalid'
      )
      manifest.protocol = 17
      writeFileSync(manifestPath, JSON.stringify(manifest))
      writeFileSync(executable, 'tampered')
      expect(() => verifyManagedHerdrExecutable(executable)).toThrow('SHA-256 checksum mismatch')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
