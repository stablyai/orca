import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLegacyDaemonAdapters } from './daemon-legacy-adapters'
import { getDaemonPidPath, getDaemonTokenPath } from './daemon-spawner'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS } from './types'

const PROTOCOL_VERSION = PREVIOUS_DAEMON_PROTOCOL_VERSIONS[0]
const RECORDED_PID = 424_242
const RECORD = JSON.stringify({ pid: RECORDED_PID, startedAtMs: 1, launchNonce: 'dead-nonce' })

let runtimeDir: string
let pidPath: string
let tokenPath: string

function failKillFor(code: string | null, onProbe?: () => void): void {
  const realKill = process.kill.bind(process)
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid !== RECORDED_PID) {
      return realKill(pid, signal)
    }
    onProbe?.()
    throw Object.assign(new Error(`kill failed: ${code}`), code ? { code } : {})
  })
}

async function runDiscovery(): Promise<void> {
  // No socket exists in the temp runtime dir, so every previous version fails its probe.
  expect(await createLegacyDaemonAdapters(runtimeDir, join(runtimeDir, 'history'))).toEqual([])
}

describe('createLegacyDaemonAdapters: ownership files of an unreachable previous daemon', () => {
  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'daemon-legacy-adapters-'))
    pidPath = getDaemonPidPath(runtimeDir, PROTOCOL_VERSION)
    tokenPath = getDaemonTokenPath(runtimeDir, PROTOCOL_VERSION)
    writeFileSync(pidPath, RECORD)
    writeFileSync(tokenPath, 'legacy-token')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(runtimeDir, { recursive: true, force: true })
  })

  it('deletes the pid record and token once the recorded process is proven gone', async () => {
    failKillFor('ESRCH')
    await runDiscovery()
    expect(existsSync(pidPath)).toBe(false)
    expect(existsSync(tokenPath)).toBe(false)
  })

  it.each(['EPERM', 'EINVAL', null])(
    'keeps both files when the process check fails with %s',
    async (code) => {
      failKillFor(code)
      await runDiscovery()
      expect(readFileSync(pidPath, 'utf8')).toBe(RECORD)
      expect(readFileSync(tokenPath, 'utf8')).toBe('legacy-token')
    }
  )

  it('keeps the token when the pid record cannot be read', async () => {
    rmSync(pidPath)
    // A directory at the record path fails the read on every platform.
    mkdirSync(pidPath)
    failKillFor('ESRCH')
    await runDiscovery()
    expect(readFileSync(tokenPath, 'utf8')).toBe('legacy-token')
    expect(process.kill).not.toHaveBeenCalledWith(RECORDED_PID, 0)
  })

  it.each(['', 'not a daemon pid record'])(
    'keeps both files when the pid record is %j',
    async (record) => {
      writeFileSync(pidPath, record)
      failKillFor('ESRCH')
      await runDiscovery()
      expect(readFileSync(pidPath, 'utf8')).toBe(record)
      expect(readFileSync(tokenPath, 'utf8')).toBe('legacy-token')
      // An empty record parses to pid 0, which would probe our own process group.
      expect(process.kill).not.toHaveBeenCalledWith(0, 0)
    }
  )

  it('keeps a record and token republished after the process check proved the old one gone', async () => {
    const republished = JSON.stringify({ pid: 515_151, startedAtMs: 2, launchNonce: 'new-nonce' })
    failKillFor('ESRCH', () => {
      writeFileSync(pidPath, republished)
      writeFileSync(tokenPath, 'new-token')
    })
    await runDiscovery()
    expect(readFileSync(pidPath, 'utf8')).toBe(republished)
    expect(readFileSync(tokenPath, 'utf8')).toBe('new-token')
  })
})
