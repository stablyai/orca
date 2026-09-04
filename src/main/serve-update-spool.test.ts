import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getHelperMarkerPath, getRequestPath, getResultPath } from '../shared/serve-update-spool'
import {
  clearUpdateRequest,
  clearUpdateResult,
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

  it('binds the result to the requesting runtimeId and target version', () => {
    writeFileSync(
      getResultPath(spoolDir),
      JSON.stringify({
        runtimeId: 'rt-1',
        targetVersion: '1.4.198',
        phase: 'rejected',
        reason: 'hash mismatch'
      })
    )
    expect(readServeUpdateResultFor('rt-2', '1.4.198')).toBeNull()
    expect(readServeUpdateResultFor('rt-1', '1.4.199')).toBeNull()
    expect(readServeUpdateResultFor('rt-1', '1.4.198')).toEqual({
      verdict: 'rejected',
      message: 'Update rejected: hash mismatch'
    })
    writeFileSync(
      getResultPath(spoolDir),
      JSON.stringify({
        runtimeId: 'rt-1',
        targetVersion: '1.4.198',
        phase: 'failed',
        reason: 'disk full'
      })
    )
    expect(readServeUpdateResultFor('rt-1', '1.4.198')).toEqual({
      verdict: 'failed',
      message: 'Update failed: disk full'
    })
    writeFileSync(
      getResultPath(spoolDir),
      JSON.stringify({ runtimeId: 'rt-1', targetVersion: '1.4.198', phase: 'ok' })
    )
    expect(readServeUpdateResultFor('rt-1', '1.4.198')).toEqual({
      verdict: 'accepted',
      message: ''
    })
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
