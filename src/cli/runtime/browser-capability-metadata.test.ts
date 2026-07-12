import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeBrowserCapabilityMetadata } from './browser-capability-metadata'

describe('writeBrowserCapabilityMetadata', () => {
  it('writes a complete runtime descriptor with only the scoped token changed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-browser-capability-'))
    const destination = writeBrowserCapabilityMetadata(
      directory,
      mkdtempSync(join(tmpdir(), 'orca-runtime-source-')),
      {
        runtimeId: 'runtime-1',
        pid: 123,
        transports: [{ kind: 'unix', endpoint: '/tmp/orca.sock' }],
        authToken: 'global-token',
        startedAt: 1
      },
      'scoped-token'
    )

    expect(JSON.parse(readFileSync(destination, 'utf8'))).toEqual({
      runtimeId: 'runtime-1',
      pid: 123,
      transports: [{ kind: 'unix', endpoint: '/tmp/orca.sock' }],
      authToken: 'scoped-token',
      startedAt: 1,
      authScope: 'browser-capability'
    })
    if (process.platform !== 'win32') {
      expect(statSync(destination).mode & 0o777).toBe(0o600)
    }
  })

  it('refuses to overwrite the active runtime metadata directory', () => {
    const sourceDirectory = mkdtempSync(join(tmpdir(), 'orca-runtime-source-'))

    expect(() =>
      writeBrowserCapabilityMetadata(
        sourceDirectory,
        sourceDirectory,
        {
          runtimeId: 'runtime-1',
          pid: 123,
          transports: [{ kind: 'unix', endpoint: '/tmp/orca.sock' }],
          authToken: 'global-token',
          startedAt: 1
        },
        'scoped-token'
      )
    ).toThrow(/must not overwrite/)
  })
})
