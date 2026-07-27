import { describe, expect, it, vi } from 'vitest'
import {
  MAX_AGGREGATED_PTY_PROCESS_LIST_BYTES,
  MAX_AGGREGATED_PTY_PROCESS_LIST_ENTRIES,
  PTY_PROCESS_LIST_PROVIDER_BATCH_SIZE
} from './pty-process-list-admission'
import {
  collectPtySessionIdListings,
  PtySessionIdListAdmission
} from './pty-session-id-list-admission'

describe('PtySessionIdListAdmission', () => {
  it('validates, bounds, and deduplicates session IDs', () => {
    const admission = new PtySessionIdListAdmission()
    expect(admission.admit('pty-1')).toBe(true)
    expect(admission.admit('pty-1')).toBe(false)
    expect(() => admission.admit('')).toThrow('invalid_pty_session_id_list')
    expect(() => admission.admit(42)).toThrow('invalid_pty_session_id_list')

    const entryAdmission = new PtySessionIdListAdmission()
    for (let index = 0; index < MAX_AGGREGATED_PTY_PROCESS_LIST_ENTRIES; index += 1) {
      entryAdmission.admit(`pty-${index}`)
    }
    expect(() => entryAdmission.admit('one-more')).toThrow('pty_session_id_list_capacity')

    expect(() =>
      new PtySessionIdListAdmission().admit('x'.repeat(MAX_AGGREGATED_PTY_PROCESS_LIST_BYTES + 1))
    ).toThrow('pty_session_id_list_capacity')
  })
})

describe('collectPtySessionIdListings', () => {
  it('deduplicates listings and bounds provider concurrency', async () => {
    let active = 0
    let peak = 0
    const finishes: (() => void)[] = []
    const load = vi.fn(
      async (source: number) =>
        await new Promise<string[]>((resolve) => {
          active += 1
          peak = Math.max(peak, active)
          finishes.push(() => {
            active -= 1
            resolve(['shared', `pty-${source}`])
          })
        })
    )
    const collecting = collectPtySessionIdListings(
      Array.from({ length: PTY_PROCESS_LIST_PROVIDER_BATCH_SIZE + 1 }, (_, index) => index),
      load
    )

    await vi.waitFor(() => expect(finishes).toHaveLength(PTY_PROCESS_LIST_PROVIDER_BATCH_SIZE))
    finishes.splice(0).forEach((finish) => finish())
    await vi.waitFor(() => expect(finishes).toHaveLength(1))
    finishes.splice(0).forEach((finish) => finish())

    await expect(collecting).resolves.toEqual([
      'shared',
      'pty-0',
      'pty-1',
      'pty-2',
      'pty-3',
      'pty-4'
    ])
    expect(peak).toBe(PTY_PROCESS_LIST_PROVIDER_BATCH_SIZE)
  })
})
