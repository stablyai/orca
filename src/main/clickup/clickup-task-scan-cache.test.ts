import { describe, expect, it } from 'vitest'
import {
  clearScannedClickUpPages,
  readScannedClickUpPage,
  scannedClickUpPagesEpoch,
  writeScannedClickUpPage
} from './clickup-task-scan-cache'

const PAGE = { tasks: [], nextPage: 1 }

describe('scanned page cache epoch', () => {
  it('keeps a page fetched under the current epoch', () => {
    clearScannedClickUpPages()
    writeScannedClickUpPage('current', PAGE, scannedClickUpPagesEpoch())
    expect(readScannedClickUpPage('current')).toBe(PAGE)
  })

  it('drops a page whose fetch began before a clear', () => {
    clearScannedClickUpPages()
    const epochAtFetchStart = scannedClickUpPagesEpoch()
    clearScannedClickUpPages()
    writeScannedClickUpPage('stale', PAGE, epochAtFetchStart)
    expect(readScannedClickUpPage('stale')).toBeNull()
  })
})
