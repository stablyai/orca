import { describe, expect, it, vi } from 'vitest'
import {
  MAX_AGGREGATED_PTY_PROCESS_LIST_BYTES,
  MAX_AGGREGATED_PTY_PROCESS_LIST_ENTRIES,
  MAX_AGGREGATED_PTY_PROCESS_LIST_OWNERS,
  PTY_PROCESS_LIST_PROVIDER_BATCH_SIZE,
  PtyProcessListAdmission,
  visitPtyProcessListingsInBatches
} from './pty-process-list-admission'

describe('PtyProcessListAdmission', () => {
  const evidence = {
    verdict: 'live' as const,
    processName: 'codex',
    authorityGeneration: 'relay-generation',
    observationEpoch: 4,
    capturedAgeMs: 12
  }

  it('preserves and clones optional foreground evidence', () => {
    const admission = new PtyProcessListAdmission()
    const admitted = admission.admit({
      id: 'pty-1',
      cwd: '/repo',
      title: 'shell',
      foregroundProcessEvidence: evidence
    })
    expect(admitted.foregroundProcessEvidence).toEqual(evidence)
    expect(admitted.foregroundProcessEvidence).not.toBe(evidence)
  })

  it('preserves optional cached process names and accepts inventories from older hosts', () => {
    const base = { id: 'pty-1', cwd: '/repo', title: 'shell' }
    expect(new PtyProcessListAdmission().admit({ ...base, foregroundProcess: 'codex' })).toEqual({
      ...base,
      foregroundProcess: 'codex'
    })
    expect(new PtyProcessListAdmission().admit(base)).toEqual(base)
    const malformed = { ...base, foregroundProcess: 'codex' }
    Reflect.set(malformed, 'foregroundProcess', 42)
    expect(() => new PtyProcessListAdmission().admit(malformed)).toThrow('invalid_pty_process_list')
  })

  it('rejects malformed foreground evidence instead of stripping it', () => {
    expect(() =>
      new PtyProcessListAdmission().admit({
        id: 'pty-1',
        cwd: '/repo',
        title: 'shell',
        foregroundProcessEvidence: { ...evidence, verdict: 'wat' }
      } as never)
    ).toThrow('invalid_pty_process_list')
  })

  it('admits diagnostic provenance and rejects malformed routing evidence', () => {
    const session = {
      id: 'pty',
      cwd: '/',
      title: 'shell',
      inventorySourceId: 'source',
      routed: false
    }
    expect(new PtyProcessListAdmission().admit(session)).toEqual(session)
    Reflect.set(session, 'routed', 'yes')
    expect(() => new PtyProcessListAdmission().admit(session)).toThrow('invalid_pty_process_list')
    Reflect.set(session, 'routed', false)
    Reflect.set(session, 'inventorySourceId', 1)
    expect(() => new PtyProcessListAdmission().admit(session)).toThrow('invalid_pty_process_list')
  })

  it('keeps the host verdict that a PTY is exiting', () => {
    const admission = new PtyProcessListAdmission()

    expect(admission.admit({ id: 'pty-1', cwd: '/repo', title: 'shell', exiting: true })).toEqual({
      id: 'pty-1',
      cwd: '/repo',
      title: 'shell',
      exiting: true
    })
  })

  it('strips unknown provider payloads from admitted process metadata', () => {
    const admission = new PtyProcessListAdmission()

    expect(
      admission.admit({
        id: 'pty-1',
        cwd: '/repo',
        title: 'shell',
        unknownPayload: 'x'.repeat(1024 * 1024)
      } as never)
    ).toEqual({ id: 'pty-1', cwd: '/repo', title: 'shell' })
  })

  it('rejects aggregate entry and byte amplification', () => {
    const entryAdmission = new PtyProcessListAdmission()
    for (let index = 0; index < MAX_AGGREGATED_PTY_PROCESS_LIST_ENTRIES; index += 1) {
      entryAdmission.admit({ id: `pty-${index}`, cwd: '', title: 'shell' })
    }
    expect(() => entryAdmission.admit({ id: 'one-more', cwd: '', title: 'shell' })).toThrow(
      'pty_process_list_capacity'
    )

    const byteAdmission = new PtyProcessListAdmission()
    expect(() =>
      byteAdmission.admit({
        id: 'pty-large',
        cwd: 'x'.repeat(MAX_AGGREGATED_PTY_PROCESS_LIST_BYTES),
        title: 'shell'
      })
    ).toThrow('pty_process_list_capacity')

    expect(() =>
      new PtyProcessListAdmission().admit({
        id: 'pty-owner-flood',
        cwd: '',
        title: 'shell',
        agentSessionOwners: Array.from(
          { length: MAX_AGGREGATED_PTY_PROCESS_LIST_OWNERS + 1 },
          () => ({})
        )
      } as never)
    ).toThrow('pty_process_list_capacity')
  })
})

describe('visitPtyProcessListingsInBatches', () => {
  it('never starts more than the bounded provider batch concurrently', async () => {
    let active = 0
    let peak = 0
    const finishes: (() => void)[] = []
    const load = vi.fn(
      async (source: number) =>
        await new Promise<{ id: string; cwd: string; title: string }[]>((resolve) => {
          active += 1
          peak = Math.max(peak, active)
          finishes.push(() => {
            active -= 1
            resolve([{ id: `pty-${source}`, cwd: '', title: 'shell' }])
          })
        })
    )
    const visiting = visitPtyProcessListingsInBatches(
      Array.from({ length: PTY_PROCESS_LIST_PROVIDER_BATCH_SIZE + 1 }, (_, index) => index),
      load,
      () => {}
    )

    await vi.waitFor(() => expect(finishes).toHaveLength(PTY_PROCESS_LIST_PROVIDER_BATCH_SIZE))
    finishes.splice(0).forEach((finish) => finish())
    await vi.waitFor(() => expect(finishes).toHaveLength(1))
    finishes.splice(0).forEach((finish) => finish())
    await visiting

    expect(peak).toBe(PTY_PROCESS_LIST_PROVIDER_BATCH_SIZE)
  })
})
