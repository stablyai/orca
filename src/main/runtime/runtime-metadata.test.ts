import { mkdtempSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import { clearRuntimeMetadata, readRuntimeMetadata, writeRuntimeMetadata } from './runtime-metadata'

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
      transport: {
        kind: 'unix',
        endpoint: '/tmp/orca.sock'
      },
      authToken: 'secret',
      startedAt: 100
    })

    expect(readRuntimeMetadata(userDataPath)).toEqual({
      runtimeId: 'rt_123',
      pid: 42,
      transport: {
        kind: 'unix',
        endpoint: '/tmp/orca.sock'
      },
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
      transport: null,
      authToken: null,
      startedAt: 100
    })

    clearRuntimeMetadata(userDataPath)

    expect(readRuntimeMetadata(userDataPath)).toBeNull()
    expect(getRuntimeMetadataPath(userDataPath)).toContain('orca-runtime.json')
  })

  it.runIf(process.platform !== 'win32')(
    'restricts runtime metadata permissions to the current user on Unix',
    () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-metadata-'))
      tempDirs.push(userDataPath)

      writeRuntimeMetadata(userDataPath, {
        runtimeId: 'rt_123',
        pid: 42,
        transport: {
          kind: 'unix',
          endpoint: '/tmp/orca.sock'
        },
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
