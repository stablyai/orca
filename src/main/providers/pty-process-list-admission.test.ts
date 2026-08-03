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
