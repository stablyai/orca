import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { grantDirAclAsyncMock } = vi.hoisted(() => ({
  grantDirAclAsyncMock: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../../windows/windows-directory-acl', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, grantDirAclAsync: grantDirAclAsyncMock }
})

import { CrashReportStore } from './crash-report-store'
import type { CrashReportCreateInput } from '../../../shared/crash-reporting'

const tempDirs: string[] = []

async function createStore(): Promise<{ store: CrashReportStore; filePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-crash-reports-'))
  tempDirs.push(dir)
  const filePath = path.join(dir, 'crash-reports.json')
  return { store: new CrashReportStore(filePath), filePath }
}

function input(reason = 'crashed'): CrashReportCreateInput {
  return {
    source: 'renderer',
    processType: 'renderer',
    reason,
    exitCode: 5,
    appVersion: '1.0.0',
    platform: process.platform,
    osRelease: 'test',
    arch: process.arch,
    electronVersion: '41',
    chromeVersion: '141',
    details: { path: '/Users/alice/project', code: 5 },
    breadcrumbs: [
      {
        createdAt: '2026-05-16T01:00:00.000Z',
        name: 'workspace_opened',
        data: { path: '/Users/alice/project', ssh: false },
        origin: 'renderer:42'
      }
    ]
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  grantDirAclAsyncMock.mockReset()
  grantDirAclAsyncMock.mockResolvedValue(undefined)
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('CrashReportStore', () => {
  it('serializes concurrent writes', async () => {
    const { store } = await createStore()

    await Promise.all(Array.from({ length: 5 }, (_, index) => store.record(input(`oom-${index}`))))

    await expect(store.listRecent()).resolves.toHaveLength(5)
  })
})
