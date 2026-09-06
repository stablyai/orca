import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getHelperMarkerPath, getRequestPath, getResultPath } from '../shared/serve-update-spool'
import {
  clearUpdateRequest,
  clearUpdateResult,
  getServeUpdateAttemptId,
  hasLinuxServeUpdateHelper,
  readHelperMarker,
  readServeUpdateResultFor,
  readUpdateResult,
  resetLinuxServeUpdateHelperCache,
  writeUpdateRequest
} from './serve-update-spool'

const VALID_REQUEST = {
  runtimeId: 'rt-1',
  fromVersion: '1.4.197',
  targetVersion: '1.4.198',
  artifactPath: '/home/orca/.cache/orca-updater/pending/orca-1.4.198.AppImage',
  sha512: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  servingPid: process.pid,
  unitName: 'orca-serve.service'
}

describe('serve-update-spool', () => {
  let spoolDir: string

  beforeEach(() => {
    spoolDir = mkdtempSync(join(tmpdir(), 'orca-spool-'))
    process.env.ORCA_SERVE_UPDATE_SPOOL_DIR = spoolDir
    process.env.ORCA_SERVE_UPDATE_UNIT_NAME = 'orca-serve.service'
    resetLinuxServeUpdateHelperCache()
  })

  afterEach(() => {
    delete process.env.ORCA_SERVE_UPDATE_SPOOL_DIR
    delete process.env.ORCA_SERVE_UPDATE_UNIT_NAME
    resetLinuxServeUpdateHelperCache()
    rmSync(spoolDir, { recursive: true, force: true })
  })

  it('writes a request atomically and parses it back with schemaVersion', () => {
    expect(writeUpdateRequest(VALID_REQUEST)).toBe(true)
    const raw = JSON.parse(readFileSync(getRequestPath(spoolDir), 'utf8'))
    expect(raw.schemaVersion).toBe(2)
    expect(raw.targetVersion).toBe('1.4.198')
    expect(raw.servingPid).toBe(process.pid)
    // The per-attempt id is generated at spool time and exposed for verdict binding.
    expect(typeof getServeUpdateAttemptId()).toBe('string')
    expect(getServeUpdateAttemptId()?.length).toBeGreaterThan(0)
  })

  it('overwrites a stale request', () => {
    writeUpdateRequest(VALID_REQUEST)
    expect(writeUpdateRequest({ ...VALID_REQUEST, targetVersion: '1.4.199' })).toBe(true)
    const raw = JSON.parse(readFileSync(getRequestPath(spoolDir), 'utf8'))
    expect(raw.targetVersion).toBe('1.4.199')
  })

  it('clearUpdateRequest converges when no request exists', () => {
    expect(() => clearUpdateRequest()).not.toThrow()
    writeUpdateRequest(VALID_REQUEST)
    clearUpdateRequest()
    expect(() => readFileSync(getRequestPath(spoolDir), 'utf8')).toThrow()
  })

  it('reads a well-formed result and rejects malformed ones', () => {
    expect(readUpdateResult()).toBeNull()
    writeFileSync(
      getResultPath(spoolDir),
      JSON.stringify({ phase: 'ok', targetVersion: '1.4.198' })
    )
    expect(readUpdateResult()).toEqual({ phase: 'ok', targetVersion: '1.4.198' })
    writeFileSync(getResultPath(spoolDir), JSON.stringify({ phase: 'bogus' }))
    expect(readUpdateResult()).toBeNull()
    writeFileSync(getResultPath(spoolDir), 'not json')
    expect(readUpdateResult()).toBeNull()
  })

  it('binds the result to the spooled attemptId and target version', () => {
    writeUpdateRequest(VALID_REQUEST)
    const attemptId = getServeUpdateAttemptId() as string
    writeFileSync(
      getResultPath(spoolDir),
      JSON.stringify({
        attemptId,
        targetVersion: '1.4.198',
        phase: 'rejected',
        reason: 'hash mismatch'
      })
    )
    expect(readServeUpdateResultFor('other-attempt', '1.4.198')).toBeNull()
    expect(readServeUpdateResultFor(attemptId, '1.4.199')).toBeNull()
    expect(readServeUpdateResultFor(attemptId, '1.4.198')).toEqual({
      verdict: 'rejected',
      message: 'Update rejected: hash mismatch'
    })
    writeFileSync(
      getResultPath(spoolDir),
      JSON.stringify({
        attemptId,
        targetVersion: '1.4.198',
        phase: 'failed',
        reason: 'disk full'
      })
    )
    expect(readServeUpdateResultFor(attemptId, '1.4.198')).toEqual({
      verdict: 'failed',
      message: 'Update failed: disk full'
    })
    writeFileSync(
      getResultPath(spoolDir),
      JSON.stringify({ attemptId, targetVersion: '1.4.198', phase: 'ok' })
    )
    expect(readServeUpdateResultFor(attemptId, '1.4.198')).toEqual({
      verdict: 'accepted',
      message: ''
    })
  })

  it('a re-spooled request invalidates the previous attemptId binding', () => {
    writeUpdateRequest(VALID_REQUEST)
    const firstAttempt = getServeUpdateAttemptId() as string
    writeFileSync(
      getResultPath(spoolDir),
      JSON.stringify({ attemptId: firstAttempt, targetVersion: '1.4.198', phase: 'ok' })
    )
    expect(readServeUpdateResultFor(firstAttempt, '1.4.198')).not.toBeNull()
    writeUpdateRequest({ ...VALID_REQUEST, targetVersion: '1.4.199' })
    const secondAttempt = getServeUpdateAttemptId() as string
    expect(secondAttempt).not.toBe(firstAttempt)
    // The stale verdict from the first attempt can never be read as this one's.
    expect(readServeUpdateResultFor(firstAttempt, '1.4.199')).toBeNull()
    expect(readServeUpdateResultFor(secondAttempt, '1.4.199')).toBeNull()
  })

  it('helper marker requires a matching unit name and version', () => {
    expect(hasLinuxServeUpdateHelper()).toBe(false)
    mkdirSync(spoolDir, { recursive: true })
    writeFileSync(
      getHelperMarkerPath(spoolDir),
      JSON.stringify({ helperVersion: 1, unitName: 'orca-serve.service' })
    )
    resetLinuxServeUpdateHelperCache()
    expect(hasLinuxServeUpdateHelper()).toBe(true)
    writeFileSync(
      getHelperMarkerPath(spoolDir),
      JSON.stringify({ helperVersion: 1, unitName: 'other.service' })
    )
    resetLinuxServeUpdateHelperCache()
    expect(hasLinuxServeUpdateHelper()).toBe(false)
    writeFileSync(
      getHelperMarkerPath(spoolDir),
      JSON.stringify({ helperVersion: 0, unitName: 'orca-serve.service' })
    )
    resetLinuxServeUpdateHelperCache()
    expect(hasLinuxServeUpdateHelper()).toBe(false)
    writeFileSync(getHelperMarkerPath(spoolDir), 'garbage')
    resetLinuxServeUpdateHelperCache()
    expect(hasLinuxServeUpdateHelper()).toBe(false)
    expect(readHelperMarker()).toBeNull()
  })

  it('caches the helper verdict once per process', () => {
    writeFileSync(
      getHelperMarkerPath(spoolDir),
      JSON.stringify({ helperVersion: 1, unitName: 'orca-serve.service' })
    )
    resetLinuxServeUpdateHelperCache()
    expect(hasLinuxServeUpdateHelper()).toBe(true)
    rmSync(getHelperMarkerPath(spoolDir))
    // Still true: cached.
    expect(hasLinuxServeUpdateHelper()).toBe(true)
    resetLinuxServeUpdateHelperCache()
    expect(hasLinuxServeUpdateHelper()).toBe(false)
  })

  it('clearUpdateResult converges when no result exists', () => {
    expect(() => clearUpdateResult()).not.toThrow()
  })
})
