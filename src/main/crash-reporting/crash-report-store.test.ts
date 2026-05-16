import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CrashReportStore } from './crash-report-store'
import type { CrashReportCreateInput } from '../../shared/crash-reporting'

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

  it('allows a pending report to reach one terminal status only', async () => {
    const { store } = await createStore()
    const report = await store.record(input())

    await expect(store.dismiss(report.id)).resolves.toMatchObject({ status: 'dismissed' })
    await expect(store.markSent(report.id)).resolves.toMatchObject({ status: 'dismissed' })
  })

  it('serializes concurrent writes', async () => {
    const { store } = await createStore()

    await Promise.all(Array.from({ length: 5 }, (_, index) => store.record(input(`oom-${index}`))))

    await expect(store.listRecent()).resolves.toHaveLength(5)
  })
})
