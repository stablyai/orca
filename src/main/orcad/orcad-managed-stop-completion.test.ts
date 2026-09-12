import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  orcadManagedStopRequestFilename,
  type OrcadManagedStopRequest
} from '../../shared/orcad-managed-stop-request'
import { validateOrcadDecommissionCompletion } from './orcad-decommission-acceptance'
import { completeOrcadManagedStop } from './orcad-managed-stop-completion'
import { persistOrcadCompletedStopReceipt } from './orcad-completed-stop-receipt'

vi.mock('./orcad-decommission-acceptance', () => ({ validateOrcadDecommissionCompletion: vi.fn() }))
vi.mock('./orcad-completed-stop-receipt', () => ({ persistOrcadCompletedStopReceipt: vi.fn() }))

describe('host-owned managed stop completion', () => {
  let directory: string
  let request: OrcadManagedStopRequest
  const requestPath = () => join(directory, orcadManagedStopRequestFilename(request.instance))
  const writeLock = (nonce = 'instance') =>
    writeFileSync(
      request.instance.lockPath,
      JSON.stringify({
        ...request.instance,
        nonce,
        identity: 'test-user',
        version: request.version,
        acquiredAt: '2026-09-06T00:00:00.000Z'
      })
    )
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orcad-completion-'))
    request = {
      schemaVersion: 1,
      version: '1.0.0',
      authority: {
        runtimeId: 'runtime',
        profileId: 'profile',
        profileRoot: directory,
        transactionId: '00000000-0000-4000-8000-000000000001'
      },
      instance: {
        pid: 123,
        startedAtMs: null,
        nonce: 'instance',
        lockPath: join(directory, 'orcad.lock')
      }
    }
    vi.mocked(validateOrcadDecommissionCompletion).mockReset().mockReturnValue('accepted')
    vi.mocked(persistOrcadCompletedStopReceipt).mockReset()
    writeLock()
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('writes a durable exact request and waits for lock release AND process exit', async () => {
    const probe = vi
      .fn()
      .mockReturnValueOnce('live')
      .mockReturnValueOnce('live')
      .mockReturnValue('exited')
    const sleep = vi.fn(async () => {
      rmSync(request.instance.lockPath, { force: true })
    })
    expect(
      await completeOrcadManagedStop(request, directory, {
        probeProcess: probe,
        sleep,
        attempts: 3
      })
    ).toBe('exited')
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(JSON.parse(readFileSync(requestPath(), 'utf8'))).toEqual(request)
    expect(validateOrcadDecommissionCompletion).toHaveBeenLastCalledWith(
      request.authority,
      request.version,
      directory,
      request.instance
    )
  })

  it('recovers original process exit without writing another request', async () => {
    rmSync(request.instance.lockPath)
    expect(
      await completeOrcadManagedStop(request, directory, { probeProcess: () => 'exited' })
    ).toBe('exited')
    expect(existsSync(requestPath())).toBe(false)
    expect(persistOrcadCompletedStopReceipt).toHaveBeenCalledWith(request, directory)
  })

  it('does not report completion when archiving the receipt fails', async () => {
    rmSync(request.instance.lockPath)
    vi.mocked(persistOrcadCompletedStopReceipt).mockImplementation(() => {
      throw new Error('fsync failed')
    })
    await expect(
      completeOrcadManagedStop(request, directory, { probeProcess: () => 'exited' })
    ).rejects.toThrow('fsync failed')
  })

  it('observes completed transactions but never sends another stop request', async () => {
    vi.mocked(validateOrcadDecommissionCompletion).mockReturnValue('process-exited')
    expect(await completeOrcadManagedStop(request, directory, { probeProcess: () => 'live' })).toBe(
      'unverifiable'
    )
    expect(existsSync(requestPath())).toBe(false)
    rmSync(request.instance.lockPath)
    expect(
      await completeOrcadManagedStop(request, directory, { probeProcess: () => 'exited' })
    ).toBe('exited')
    expect(existsSync(requestPath())).toBe(false)
  })

  it.each(['live', 'unverifiable'] as const)(
    'does not infer exit from lock absence with %s process',
    async (verdict) => {
      rmSync(request.instance.lockPath)
      expect(
        await completeOrcadManagedStop(request, directory, { probeProcess: () => verdict })
      ).toBe('unverifiable')
      expect(existsSync(requestPath())).toBe(false)
    }
  )

  it('retains a leftover lock even when its process exited', async () => {
    expect(
      await completeOrcadManagedStop(request, directory, { probeProcess: () => 'exited' })
    ).toBe('unverifiable')
    expect(existsSync(requestPath())).toBe(false)
  })

  it('refuses a replacement instance without touching its request', async () => {
    writeLock('replacement')
    const probe = vi.fn(() => 'live' as const)
    expect(await completeOrcadManagedStop(request, directory, { probeProcess: probe })).toBe(
      'unverifiable'
    )
    expect(probe).not.toHaveBeenCalled()
    expect(existsSync(requestPath())).toBe(false)
  })

  it('stops observing immediately if a replacement appears during teardown', async () => {
    const sleep = vi.fn(async () => {
      writeLock('replacement')
    })
    expect(
      await completeOrcadManagedStop(request, directory, { probeProcess: () => 'live', sleep })
    ).toBe('unverifiable')
    expect(sleep).toHaveBeenCalledOnce()
  })

  it('does not overwrite another transaction request', async () => {
    const other = {
      ...request,
      authority: { ...request.authority, transactionId: '00000000-0000-4000-8000-000000000002' }
    }
    writeFileSync(requestPath(), JSON.stringify(other))
    expect(await completeOrcadManagedStop(request, directory, { probeProcess: () => 'live' })).toBe(
      'unverifiable'
    )
    expect(JSON.parse(readFileSync(requestPath(), 'utf8'))).toEqual(other)
  })

  it('isolates a previous instance request without deleting its evidence', async () => {
    const previousPath = join(
      directory,
      orcadManagedStopRequestFilename({ ...request.instance, nonce: 'previous' })
    )
    writeFileSync(previousPath, 'retained evidence')
    expect(
      await completeOrcadManagedStop(request, directory, {
        probeProcess: () => 'live',
        sleep: async () => {},
        attempts: 1
      })
    ).toBe('live')
    expect(readFileSync(previousPath, 'utf8')).toBe('retained evidence')
    expect(JSON.parse(readFileSync(requestPath(), 'utf8'))).toEqual(request)
  })

  it('returns live after a bounded wait without deleting recovery evidence', async () => {
    const sleep = vi.fn(async () => {})
    expect(
      await completeOrcadManagedStop(request, directory, {
        probeProcess: () => 'live',
        sleep,
        attempts: 2
      })
    ).toBe('live')
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(existsSync(requestPath())).toBe(true)
  })

  it('revalidates acceptance after sending the request', async () => {
    vi.mocked(validateOrcadDecommissionCompletion)
      .mockImplementationOnce(() => 'accepted')
      .mockImplementation(() => {
        throw new Error('acceptance changed')
      })
    await expect(
      completeOrcadManagedStop(request, directory, {
        probeProcess: () => 'live',
        sleep: async () => {},
        attempts: 2
      })
    ).rejects.toThrow('acceptance changed')
    expect(existsSync(requestPath())).toBe(true)
  })
})
