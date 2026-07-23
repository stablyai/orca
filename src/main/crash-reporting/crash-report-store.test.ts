import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { grantDirAclAsyncMock } = vi.hoisted(() => ({
  grantDirAclAsyncMock: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../win32-utils', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, grantDirAclAsync: grantDirAclAsyncMock }
})

import {
  CrashReportStore,
  MAX_CRASH_REPORT_FILE_BYTES,
  MAX_CRASH_REPORT_JSON_STRUCTURAL_TOKENS
} from './crash-report-store'
import type { CrashReportCreateInput } from '../../shared/crash-reporting'
import * as boundedFileReader from '../../shared/node-bounded-file-reader'

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
        data: { path: '/Users/alice/project', ssh: false }
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
  it('records sanitized pending reports and returns the latest pending report', async () => {
    const { store } = await createStore()

    const report = await store.record(input())

    expect(report.status).toBe('pending')
    expect(report.details.path).toBe('[redacted-path]')
    expect(report.breadcrumbs).toEqual([
      {
        createdAt: '2026-05-16T01:00:00.000Z',
        name: 'workspace_opened',
        data: { path: '[redacted-path]', ssh: false }
      }
    ])
    await expect(store.getLatestPending()).resolves.toMatchObject({ id: report.id })
  })

  it('caps reports to the newest five', async () => {
    const { store } = await createStore()

    for (let index = 0; index < 7; index += 1) {
      await store.record(input(`crashed-${index}`))
    }

    const reports = await store.listRecent()
    expect(reports).toHaveLength(5)
    expect(reports[0].reason).toBe('crashed-6')
    expect(reports[4].reason).toBe('crashed-2')
  })

  it('recovers corrupt JSON as an empty report list', async () => {
    const { store, filePath } = await createStore()
    await fs.writeFile(filePath, '{ nope', 'utf8')

    await expect(store.listRecent()).resolves.toEqual([])
  })

  it('rejects an oversized sparse report file and recovers with the next report', async () => {
    const { store, filePath } = await createStore()
    await fs.writeFile(filePath, 'x')
    await fs.truncate(filePath, MAX_CRASH_REPORT_FILE_BYTES + 1)

    await expect(store.listRecent()).resolves.toEqual([])
    await expect(store.record(input('after-oversize'))).resolves.toMatchObject({
      reason: 'after-oversize'
    })
    await expect(store.listRecent()).resolves.toHaveLength(1)
  })

  it('rejects structurally amplified report JSON before parsing', async () => {
    const { store, filePath } = await createStore()
    await fs.writeFile(
      filePath,
      `{"reports":[${'0,'.repeat(MAX_CRASH_REPORT_JSON_STRUCTURAL_TOKENS)}0]}`,
      'utf8'
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parseSpy = vi.spyOn(JSON, 'parse')

    await expect(store.listRecent()).resolves.toEqual([])
    expect(parseSpy).not.toHaveBeenCalled()
  })

  it('preserves prior reports when the next report exceeds the write ceiling', async () => {
    const { store, filePath } = await createStore()
    await store.record(input('preserved'))
    const before = await fs.readFile(filePath, 'utf8')
    const writeSpy = vi.spyOn(fs, 'writeFile')

    await expect(store.record(input('x'.repeat(MAX_CRASH_REPORT_FILE_BYTES)))).rejects.toThrow(
      'JSON output exceeds'
    )

    expect(writeSpy).not.toHaveBeenCalled()
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(before)
  })

  it('allows a pending report to reach one terminal status only', async () => {
    const { store } = await createStore()
    const report = await store.record(input())

    await expect(store.dismiss(report.id)).resolves.toMatchObject({ status: 'dismissed' })
    await expect(store.markSent(report.id)).resolves.toMatchObject({ status: 'dismissed' })
  })

  it('dismisses sibling pending records from the same Electron crash event', async () => {
    const { store } = await createStore()
    await store.record(input())
    await store.record(input())
    const renderer = await store.record(input())

    await expect(store.dismiss(renderer.id)).resolves.toMatchObject({ status: 'dismissed' })
    await expect(store.getLatestPending()).resolves.toBeNull()
  })

  it('dismisses sibling pending records after one crash report is sent', async () => {
    const { store } = await createStore()
    await store.record(input())
    await store.record(input())
    const renderer = await store.record(input())

    await expect(store.markSent(renderer.id)).resolves.toMatchObject({ status: 'sent' })

    const reports = await store.listRecent()
    expect(reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: renderer.id, status: 'sent' }),
        expect.objectContaining({ status: 'dismissed' }),
        expect.objectContaining({ status: 'dismissed' })
      ])
    )
    await expect(store.getLatestPending()).resolves.toBeNull()
  })

  it('persists a submitted dismissed report as sent', async () => {
    const { store, filePath } = await createStore()
    const report = await store.record(input())

    await expect(store.dismiss(report.id)).resolves.toMatchObject({ status: 'dismissed' })
    await expect(store.markDismissedSent(report.id)).resolves.toMatchObject({ status: 'sent' })

    const reloaded = new CrashReportStore(filePath)
    await expect(reloaded.getById(report.id)).resolves.toMatchObject({ status: 'sent' })
  })

  it('serializes concurrent writes', async () => {
    const { store } = await createStore()

    await Promise.all(Array.from({ length: 5 }, (_, index) => store.record(input(`oom-${index}`))))

    await expect(store.listRecent()).resolves.toHaveLength(5)
  })

  it('waits for an in-flight crash write before reading the pending report', async () => {
    const { store } = await createStore()

    const recordPromise = store.record(input())
    const pendingPromise = store.getLatestPending()
    const report = await recordPromise

    await expect(pendingPromise).resolves.toMatchObject({ id: report.id, status: 'pending' })
  })

  it('repairs the Windows userData ACL and retries a denied crash write', async () => {
    const { store, filePath } = await createStore()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const permissionError = Object.assign(new Error('permission denied'), { code: 'EPERM' })
    const writeFileSpy = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(permissionError)

    const report = await store.record(input())

    expect(grantDirAclAsyncMock).toHaveBeenCalledWith(path.dirname(filePath))
    expect(writeFileSpy).toHaveBeenCalledTimes(2)
    await expect(store.getLatestPending()).resolves.toMatchObject({ id: report.id })
  })

  it.each(['EPERM', 'EACCES', 'EBUSY'] as const)(
    'recovers a pending report after a transient Windows %s read failure',
    async (code) => {
      const { store, filePath } = await createStore()
      const report = await store.record(input())
      const reloaded = new CrashReportStore(filePath)
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      const readError = Object.assign(new Error('temporary read failure'), { code })
      const readSpy = vi
        .spyOn(boundedFileReader, 'readNodeFileWithinLimit')
        .mockRejectedValueOnce(readError)

      await expect(reloaded.getLatestPending()).resolves.toMatchObject({ id: report.id })

      expect(readSpy).toHaveBeenCalledTimes(2)
      if (code === 'EBUSY') {
        expect(grantDirAclAsyncMock).not.toHaveBeenCalled()
      } else {
        expect(grantDirAclAsyncMock).toHaveBeenCalledOnce()
        expect(grantDirAclAsyncMock).toHaveBeenCalledWith(path.dirname(filePath))
      }
    }
  )

  it('retries a transient Windows rename lock', async () => {
    const { store } = await createStore()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const busyError = Object.assign(new Error('file busy'), { code: 'EBUSY' })
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(busyError)

    await expect(store.record(input())).resolves.toMatchObject({ status: 'pending' })

    expect(renameSpy).toHaveBeenCalledTimes(2)
    expect(grantDirAclAsyncMock).not.toHaveBeenCalled()
  })

  it('removes its temp file after a terminal write failure', async () => {
    const { store, filePath } = await createStore()
    const ioError = Object.assign(new Error('disk error'), { code: 'EIO' })
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(ioError)

    await expect(store.record(input())).rejects.toBe(ioError)

    const entries = await fs.readdir(path.dirname(filePath))
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })
})
