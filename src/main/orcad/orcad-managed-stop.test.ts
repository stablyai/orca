import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OrcadManagedStopCompletionSchema,
  type OrcadManagedStopRequest
} from '../../shared/orcad-stop-request'
import { acquireOrcadInstanceLock, type OrcadInstanceLock } from './orcad-instance-lock'
import {
  orcadManagedStopRequestPath,
  validateOrcadManagedStopRequest
} from './orcad-managed-stop-request'
import {
  completeOrcadManagedStop,
  type OrcadManagedStopCompletionOptions
} from './orcad-managed-stop-completion'
import {
  orcadStopReceiptPath,
  readOrcadCompletedStopReceipt,
  readOrcadDaemonRetirementRecord
} from './orcad-completed-stop-receipt'
import { prepareOrcadManagedStop } from './orcad-managed-stop-admission'
import { runOrcadManagedStopCommand } from './orcad-managed-stop-command'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function running(): { lock: OrcadInstanceLock; request: OrcadManagedStopRequest } {
  const root = mkdtempSync(join(tmpdir(), 'orcad-managed-stop-'))
  roots.push(root)
  const lock = acquireOrcadInstanceLock(root, {
    identity: () => 'uid-1000',
    version: () => '1.0.0',
    startedAtMs: () => 5_000
  })
  const { pid, startedAtMs, nonce } = lock.record
  return {
    lock,
    request: {
      schemaVersion: 1,
      transactionId: '0b9f6a3e-9e2c-4c8e-8f58-4c0f6b1d2e3a',
      version: '1.0.0',
      runtimeId: 'runtime-1',
      instance: { pid, startedAtMs, nonce, lockPath: lock.path }
    }
  }
}

const context = ({ version, runtimeId, instance }: OrcadManagedStopRequest) => ({
  version,
  runtimeId,
  instance
})

function options(
  overrides: Partial<OrcadManagedStopCompletionOptions> = {}
): OrcadManagedStopCompletionOptions {
  return {
    probeProcess: () => 'alive',
    startedAtMs: () => 5_000,
    sleep: async () => {},
    attempts: 3,
    now: () => new Date('2026-10-01T00:00:00.000Z'),
    ...overrides
  }
}

describe('managed stop requests', () => {
  it('keys the request file to the instance, so a previous instance never matches', () => {
    const { request } = running()
    const other = { ...request.instance, nonce: 'other' }
    expect(orcadManagedStopRequestPath(request.instance)).not.toBe(
      orcadManagedStopRequestPath(other)
    )
  })

  it('accepts only a request naming this runtime, version and instance', () => {
    const { request } = running()
    const path = orcadManagedStopRequestPath(request.instance)
    writeFileSync(path, JSON.stringify(request))
    expect(validateOrcadManagedStopRequest(context(request), path)).toEqual(request)
    for (const mismatch of [
      { ...request, version: '0.9.0' },
      { ...request, runtimeId: 'runtime-2' },
      { ...request, instance: { ...request.instance, pid: request.instance.pid + 1 } }
    ]) {
      writeFileSync(path, JSON.stringify(mismatch))
      expect(() => validateOrcadManagedStopRequest(context(request), path)).toThrow(
        'identity_mismatch'
      )
    }
  })

  it('refuses a request once the instance lock names another holder', () => {
    const { lock, request } = running()
    const path = orcadManagedStopRequestPath(request.instance)
    writeFileSync(path, JSON.stringify(request))
    writeFileSync(lock.path, JSON.stringify({ ...lock.record, nonce: 'successor' }))
    expect(() => validateOrcadManagedStopRequest(context(request), path)).toThrow(
      'instance_lock_changed'
    )
  })
})

describe('completing a managed stop', () => {
  it('writes the request, waits for proven exit, then persists a receipt', async () => {
    const { request } = running()
    const probes = ['alive', 'alive', 'missing'] as const
    let index = 0
    const verdict = await completeOrcadManagedStop(
      request,
      options({ probeProcess: () => probes[Math.min(index++, probes.length - 1)] })
    )
    expect(verdict).toBe('exited')
    expect(JSON.parse(readFileSync(orcadManagedStopRequestPath(request.instance), 'utf8'))).toEqual(
      request
    )
    expect(readOrcadCompletedStopReceipt(request)).toMatchObject({
      kind: 'orcad_managed_stop_completed',
      exitedAt: '2026-10-01T00:00:00.000Z'
    })
  })

  it('treats a reused PID with a different start time as proof of exit', async () => {
    const { request } = running()
    expect(await completeOrcadManagedStop(request, options({ startedAtMs: () => 99_000 }))).toBe(
      'exited'
    )
  })

  it.each([
    ['an unanswerable probe', { probeProcess: () => 'unverifiable' as const }],
    ['a reused PID with no readable start time', { startedAtMs: () => null, attempts: 1 }]
  ])('never reports exit for %s', async (_name, overrides) => {
    const { request } = running()
    const verdict = await completeOrcadManagedStop(request, options(overrides))
    expect(verdict).not.toBe('exited')
    expect(existsSync(orcadStopReceiptPath(request, 'completed'))).toBe(false)
  })

  it('reports a still-running instance as live after its attempts', async () => {
    const { request } = running()
    expect(await completeOrcadManagedStop(request, options())).toBe('live')
  })

  it('does not address a live process that no longer holds the lock it published', async () => {
    const { lock, request } = running()
    writeFileSync(lock.path, JSON.stringify({ ...lock.record, nonce: 'successor' }))
    expect(await completeOrcadManagedStop(request, options())).toBe('unverifiable')
    expect(existsSync(orcadManagedStopRequestPath(request.instance))).toBe(false)
  })

  it('does not overwrite another transaction pending for the same instance', async () => {
    const { request } = running()
    const pending = { ...request, transactionId: '5a7e1f0c-3b2d-4e6f-9a8b-7c6d5e4f3a2b' }
    writeFileSync(orcadManagedStopRequestPath(request.instance), JSON.stringify(pending))
    expect(await completeOrcadManagedStop(request, options())).toBe('unverifiable')
  })

  it('prints one completion line through the command', async () => {
    const { request } = running()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const completion = await runOrcadManagedStopCommand(
      ['--complete-managed-stop', JSON.stringify(request)],
      options({ probeProcess: () => 'missing' })
    )
    expect(completion).toMatchObject({ verdict: 'exited', receiptPersisted: true })
    expect(
      OrcadManagedStopCompletionSchema.parse(JSON.parse(String(write.mock.calls[0]?.[0])))
    ).toEqual(completion)
    await expect(runOrcadManagedStopCommand(['--complete-managed-stop'])).rejects.toThrow(
      'invalid_arguments'
    )
  })
})

describe('managed stops that retire the daemon', () => {
  const outcome = (retirement: 'retired' | 'live' | 'unverifiable', liveSessions: number | null) =>
    vi.fn(async () => ({ retirement, liveSessions, reason: null }))

  it('does not touch the daemon when retirement was not asked for', async () => {
    const { request } = running()
    const retire = outcome('retired', 0)
    await prepareOrcadManagedStop(request, retire)
    expect(retire).not.toHaveBeenCalled()
    expect(readOrcadDaemonRetirementRecord(request)).toBeNull()
  })

  it.each([
    ['retired', 0],
    ['live', 2],
    ['unverifiable', null]
  ] as const)(
    'still completes the stop and records retirement %s on the receipt',
    async (retirement, liveSessions) => {
      const { request } = running()
      const retireRequest = { ...request, retireIdleDaemon: true as const }
      await prepareOrcadManagedStop(retireRequest, outcome(retirement, liveSessions))
      expect(readOrcadDaemonRetirementRecord(retireRequest)).toMatchObject({
        retirement,
        liveSessions
      })
      expect(
        await completeOrcadManagedStop(retireRequest, options({ probeProcess: () => 'missing' }))
      ).toBe('exited')
      expect(readOrcadCompletedStopReceipt(retireRequest)).toMatchObject({ retirement })
    }
  )

  it('records unverifiable when the retirement attempt itself failed', async () => {
    const { request } = running()
    const retireRequest = { ...request, retireIdleDaemon: true as const }
    await prepareOrcadManagedStop(retireRequest, async () => {
      throw new Error('daemon socket closed')
    })
    expect(readOrcadDaemonRetirementRecord(retireRequest)).toMatchObject({
      retirement: 'unverifiable'
    })
  })

  it('reports unverifiable when orcad exited without recording retirement', async () => {
    const { request } = running()
    const retireRequest = { ...request, retireIdleDaemon: true as const }
    await completeOrcadManagedStop(retireRequest, options({ probeProcess: () => 'missing' }))
    expect(readOrcadCompletedStopReceipt(retireRequest)).toMatchObject({
      retirement: 'unverifiable'
    })
  })

  it('omits retirement from the receipt of a plain managed stop', async () => {
    const { request } = running()
    await completeOrcadManagedStop(request, options({ probeProcess: () => 'missing' }))
    expect(readOrcadCompletedStopReceipt(request)).not.toHaveProperty('retirement')
  })

  it('reports the recorded retirement in the completion line, so a client need not read files', async () => {
    const { request } = running()
    const retireRequest = { ...request, retireIdleDaemon: true as const }
    await prepareOrcadManagedStop(retireRequest, outcome('live', 1))
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(
      await runOrcadManagedStopCommand(
        ['--complete-managed-stop', JSON.stringify(retireRequest)],
        options({ probeProcess: () => 'missing' })
      )
    ).toMatchObject({ verdict: 'exited', retirement: 'live' })
  })
})
