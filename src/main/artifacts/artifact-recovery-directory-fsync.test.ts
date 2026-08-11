import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    fsyncSync: (descriptor: number) => {
      if (actual.fstatSync(descriptor).isDirectory()) {
        throw new Error('directory fsync unsupported')
      }
      return actual.fsyncSync(descriptor)
    }
  }
})

import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  clearArtifactCreateIntents,
  getOrCreateArtifactCreateIntent
} from './artifact-create-intent-store'

const createdPaths: string[] = []

afterEach(() => {
  for (const path of createdPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
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
