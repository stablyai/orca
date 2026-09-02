import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const fsyncMockState = vi.hoisted(() => ({
  directoryDescriptor: -1,
  directoryErrorCode: 'EINVAL'
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    closeSync: (descriptor: number) => {
      if (descriptor !== fsyncMockState.directoryDescriptor) {
        actual.closeSync(descriptor)
      }
    },
    fsyncSync: (descriptor: number) => {
      if (descriptor === fsyncMockState.directoryDescriptor) {
        throw Object.assign(new Error('directory fsync failed'), {
          code: fsyncMockState.directoryErrorCode
        })
      }
      return actual.fsyncSync(descriptor)
    },
    openSync: (path: string, flags: string | number) =>
      actual.statSync(path).isDirectory()
        ? fsyncMockState.directoryDescriptor
        : actual.openSync(path, flags)
  }
})

import { bestEffortFsyncDirectorySync, writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  clearArtifactCreateIntents,
  getOrCreateArtifactCreateIntent
} from './artifact-create-intent-store'

const createdPaths: string[] = []

afterEach(() => {
  fsyncMockState.directoryErrorCode = 'EINVAL'
  for (const path of createdPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

it('skips directory fsync on Windows and propagates I/O failures elsewhere', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-artifact-directory-fsync-eio-'))
  createdPaths.push(directory)
  fsyncMockState.directoryErrorCode = 'EIO'

  const fsyncDirectory = (): void => bestEffortFsyncDirectorySync(directory)
  if (process.platform === 'win32') {
    expect(fsyncDirectory).not.toThrow()
  } else {
    expect(fsyncDirectory).toThrow('directory fsync failed')
  }
})

it('keeps durable artifact records usable when directory fsync is unsupported', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-artifact-directory-fsync-'))
  createdPaths.push(userDataPath)
  const recordPath = join(userDataPath, 'artifact-shares.json')

  expect(() => writeDurableSecureJsonFile(recordPath, { ok: true })).not.toThrow()
  expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toEqual({ ok: true })

  expect(() =>
    getOrCreateArtifactCreateIntent(
      'local-profile',
      userDataPath,
      '/repo/report.html',
      {
        cloudUserId: 'user-a',
        cloudProfileId: 'profile-a',
        cloudOrganizationId: 'org-a',
        apiOrigin: 'https://share.onorca.dev'
      },
      'key-a',
      { content: 'hello', contentType: 'text/markdown', fileName: 'report.md' }
    )
  ).not.toThrow()
  expect(() => clearArtifactCreateIntents('local-profile', userDataPath)).not.toThrow()
})
