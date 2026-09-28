import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from '../main/sqlite/sync-database'
import { seedHermesSessionRun } from './hermes-session-run-fixture'

const fixture = vi.hoisted(() => ({ path: '' }))
vi.mock('./external-automation-storage-paths', () => ({
  get HERMES_STATE_DB() {
    return fixture.path
  }
}))
import {
  readHermesSessionDbRunById,
  readHermesSessionDbRunRefs
} from './hermes-session-run-database'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-hermes-db-'))
  fixture.path = join(home, 'state.db')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

it('reads session history and output from an existing database', () => {
  seedHermesSessionRun(home)
  expect(readHermesSessionDbRunRefs('job-1')).toEqual([
    expect.objectContaining({ id: 'cron_job-1_20260701_100000', kind: 'session', job_id: 'job-1' })
  ])
  expect(readHermesSessionDbRunById('job-1', 'cron_job-1_20260701_100000')).toMatchObject({
    status: 'completed',
    output_content: '## assistant\n\nDatabase-backed run output',
    output_preview: 'Scheduled fixture · Model: fixture-model · 1 messages · 30 tokens'
  })
})

it('does not treat SQL LIKE metacharacters in a job ID as wildcards', () => {
  seedHermesSessionRun(home)
  const db = new Database(fixture.path)
  try {
    db.prepare('UPDATE sessions SET id = ?').run('cron_job_%_20260701_100000')
  } finally {
    db.close()
  }
  expect(readHermesSessionDbRunRefs('job_%')).toHaveLength(1)
  expect(readHermesSessionDbRunRefs('job_')).toEqual([])
})

it('does not create a missing external database', () => {
  expect(readHermesSessionDbRunRefs('job-1')).toEqual([])
  expect(readHermesSessionDbRunById('job-1', 'missing')).toBeNull()
  expect(existsSync(fixture.path)).toBe(false)
})

it('keeps unavailable or damaged external history optional', () => {
  writeFileSync(fixture.path, 'not a database')
  expect(readHermesSessionDbRunRefs('job-1')).toEqual([])
  expect(readHermesSessionDbRunById('job-1', 'missing')).toBeNull()
})
