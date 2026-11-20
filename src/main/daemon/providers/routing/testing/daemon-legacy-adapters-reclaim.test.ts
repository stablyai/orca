import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDaemonPidPath, getDaemonTokenPath } from '../../../launch/daemon-spawner'
import type * as LegacyProcessLiveness from '../../../launch/daemon-legacy-process-liveness'
import { createLegacyDaemonAdapters } from '../daemon-legacy-adapters'

const afterInspection = vi.hoisted(() => {
  const hook: { run: null | (() => void) } = { run: null }
  return hook
})

vi.mock('../../../launch/daemon-legacy-process-liveness', async (importOriginal) => {
  const actual = await importOriginal<typeof LegacyProcessLiveness>()
  return {
    ...actual,
    inspectLegacyDaemonRecord: (runtimeDir: string, protocolVersion: number) => {
      const verdict = actual.inspectLegacyDaemonRecord(runtimeDir, protocolVersion)
      afterInspection.run?.()
      return verdict
    }
  }
})

const VERSION = 1
const EXITED_PID = 0x7ffffff0

describe('createLegacyDaemonAdapters reclaim of an unreachable legacy daemon', () => {
  let runtimeDir: string
  let pidPath: string
  let tokenPath: string

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'orca-legacy-reclaim-'))
    pidPath = getDaemonPidPath(runtimeDir, VERSION)
    tokenPath = getDaemonTokenPath(runtimeDir, VERSION)
    afterInspection.run = null
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(runtimeDir, { recursive: true, force: true })
  })

  const reclaim = () => createLegacyDaemonAdapters(runtimeDir, join(runtimeDir, 'history'))

  it('keeps the token when the pid record cannot be read', async () => {
    mkdirSync(pidPath)
    writeFileSync(tokenPath, 'old-token')

    await reclaim()

    expect(readFileSync(tokenPath, 'utf8')).toBe('old-token')
  })

  it('reclaims a bare-integer record whose process has exited', async () => {
    writeFileSync(pidPath, String(EXITED_PID))
    writeFileSync(tokenPath, 'old-token')

    await reclaim()

    expect(existsSync(pidPath)).toBe(false)
    expect(existsSync(tokenPath)).toBe(false)
  })

  it('keeps a token republished after the exited record was inspected', async () => {
    writeFileSync(pidPath, JSON.stringify({ pid: EXITED_PID, launchNonce: 'dead' }))
    writeFileSync(tokenPath, 'old-token')
    afterInspection.run = () => writeFileSync(tokenPath, 'new-token')

    await reclaim()

    expect(existsSync(pidPath)).toBe(false)
    expect(readFileSync(tokenPath, 'utf8')).toBe('new-token')
  })

  it('keeps a record and token republished after the exited record was inspected', async () => {
    writeFileSync(pidPath, JSON.stringify({ pid: EXITED_PID, launchNonce: 'dead' }))
    writeFileSync(tokenPath, 'old-token')
    const replacement = JSON.stringify({ pid: process.pid, launchNonce: 'replacement' })
    afterInspection.run = () => {
      writeFileSync(pidPath, replacement)
      writeFileSync(tokenPath, 'new-token')
    }

    await reclaim()

    expect(readFileSync(pidPath, 'utf8')).toBe(replacement)
    expect(readFileSync(tokenPath, 'utf8')).toBe('new-token')
  })
})
