import { mkdtempSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import {
  clearRuntimeMetadata,
  clearRuntimeMetadataIfOwned,
  readRuntimeMetadata,
  writeRuntimeMetadata
} from './runtime-metadata'

const tempDirs: string[] = []

describe('runtime metadata', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      clearRuntimeMetadata(dir)
    }
  })

  it('writes and reads runtime metadata atomically', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-metadata-'))
    tempDirs.push(userDataPath)

    writeRuntimeMetadata(userDataPath, {
      runtimeId: 'rt_123',
      pid: 42,
      transports: [
        {
          kind: 'unix',
          endpoint: '/tmp/orca.sock'
        }
      ],
      authToken: 'secret',
      startedAt: 100
    })

    expect(readRuntimeMetadata(userDataPath)).toEqual({
      runtimeId: 'rt_123',
      pid: 42,
      transports: [
        {
          kind: 'unix',
          endpoint: '/tmp/orca.sock'
        }
      ],
      authToken: 'secret',
      startedAt: 100
    })
  })

  it('clears the runtime metadata file', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-metadata-'))
    tempDirs.push(userDataPath)

    writeRuntimeMetadata(userDataPath, {
      runtimeId: 'rt_123',
      pid: 42,
      transports: [],
      authToken: null,
      startedAt: 100
    })

    clearRuntimeMetadata(userDataPath)

    expect(readRuntimeMetadata(userDataPath)).toBeNull()
    expect(getRuntimeMetadataPath(userDataPath)).toContain('orca-runtime.json')
  })

  describe('clearRuntimeMetadataIfOwned', () => {
    it('clears metadata when pid and runtimeId both match', () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-metadata-'))
      tempDirs.push(userDataPath)
      writeRuntimeMetadata(userDataPath, {
        runtimeId: 'rt_owner',
        pid: 42,
        transports: [],
        authToken: null,
        startedAt: 100
      })

      clearRuntimeMetadataIfOwned(userDataPath, 42, 'rt_owner')

      expect(readRuntimeMetadata(userDataPath)).toBeNull()
    })

    it('retains metadata when the pid does not match (simulates auto-update handoff)', () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-metadata-'))
      tempDirs.push(userDataPath)
      writeRuntimeMetadata(userDataPath, {
        runtimeId: 'rt_replacement',
        pid: 999,
        transports: [],
        authToken: null,
        startedAt: 200
      })

      clearRuntimeMetadataIfOwned(userDataPath, 42, 'rt_owner')

      expect(readRuntimeMetadata(userDataPath)).toMatchObject({
        pid: 999,
        runtimeId: 'rt_replacement'
      })
    })

    it('retains metadata when only the runtimeId differs', () => {
      // Why: pid reuse is possible across an auto-update (fork+exec keeps the
      // old pid if the OS reassigns it quickly). The runtimeId check is the
      // second-level guard that catches this even when pid collides.
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-metadata-'))
      tempDirs.push(userDataPath)
      writeRuntimeMetadata(userDataPath, {
        runtimeId: 'rt_replacement',
        pid: 42,
        transports: [],
        authToken: null,
        startedAt: 200
      })

      clearRuntimeMetadataIfOwned(userDataPath, 42, 'rt_owner')

      expect(readRuntimeMetadata(userDataPath)).toMatchObject({
        pid: 42,
        runtimeId: 'rt_replacement'
      })
    })

    it('is a no-op when no metadata exists', () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-metadata-'))
      tempDirs.push(userDataPath)

      expect(() => clearRuntimeMetadataIfOwned(userDataPath, 42, 'rt_owner')).not.toThrow()
      expect(readRuntimeMetadata(userDataPath)).toBeNull()
    })
  })

  it.runIf(process.platform !== 'win32')(
    'restricts runtime metadata permissions to the current user on Unix',
    () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-metadata-'))
      tempDirs.push(userDataPath)

      writeRuntimeMetadata(userDataPath, {
        runtimeId: 'rt_123',
        pid: 42,
        transports: [
          {
            kind: 'unix',
            endpoint: '/tmp/orca.sock'
          }
        ],
        authToken: 'secret',
        startedAt: 100
      })

      const metadataMode = statSync(getRuntimeMetadataPath(userDataPath)).mode & 0o777
      const directoryMode = statSync(userDataPath).mode & 0o777

      expect(metadataMode).toBe(0o600)
      expect(directoryMode).toBe(0o700)
    }
  )
})
