import { describe, expect, it, vi } from 'vitest'
import type { Session } from './session'
import {
  consumeExitReceipt,
  MAX_EXIT_RECEIPTS,
  reapSessionRecord,
  type TerminalHostSessionRecord
} from './terminal-host-session-record'

function session(id: string, isAlive = false): Session {
  return {
    incarnationId: id,
    isAlive,
    killRequested: false,
    exitCode: 0,
    dispose: vi.fn()
  } as unknown as Session
}

function fillReceipts(records: Map<string, TerminalHostSessionRecord>): void {
  for (let i = 0; i < MAX_EXIT_RECEIPTS; i++) {
    records.set(`exit-${i}`, { incarnationId: `inc-${i}`, code: 0 })
  }
}

describe('host exit receipt budget', () => {
  it('bounds sustained unacknowledged exit churn without evicting live sessions', () => {
    const live = session('live', true)
    const records = new Map<string, TerminalHostSessionRecord>([['live', live]])
    for (let i = 0; i < MAX_EXIT_RECEIPTS * 3; i++) {
      records.set(`exit-${i}`, session(`inc-${i}`))
      expect(reapSessionRecord(records, `exit-${i}`)).toBe(true)
      expect(records.size).toBeLessThanOrEqual(MAX_EXIT_RECEIPTS + 1)
    }
    expect(records.get('live')).toBe(live)
    expect(live.dispose).not.toHaveBeenCalled()
    expect(records.has(`exit-${MAX_EXIT_RECEIPTS * 2 - 1}`)).toBe(false)
    expect(records.has(`exit-${MAX_EXIT_RECEIPTS * 2}`)).toBe(true)
    expect(records.get(`exit-${MAX_EXIT_RECEIPTS * 3 - 1}`)).toEqual({
      incarnationId: `inc-${MAX_EXIT_RECEIPTS * 3 - 1}`,
      code: 0
    })
  })

  it('orders receipts by exit rather than process creation', () => {
    const records = new Map<string, TerminalHostSessionRecord>([
      ['long-running', session('old-launch')]
    ])
    fillReceipts(records)
    reapSessionRecord(records, 'long-running')
    expect(records.size).toBe(MAX_EXIT_RECEIPTS)
    expect(records.has('exit-0')).toBe(false)
    expect(records.get('long-running')).toEqual({ incarnationId: 'old-launch', code: 0 })
  })

  it('does not count live sessions or acknowledged receipts against the budget', () => {
    const records = new Map<string, TerminalHostSessionRecord>()
    for (let i = 0; i < MAX_EXIT_RECEIPTS + 1; i++) {
      records.set(`live-${i}`, session(`live-${i}`, true))
    }
    fillReceipts(records)
    consumeExitReceipt(records, 'exit-0', 'inc-0')
    records.set('new-exit', session('new-incarnation'))
    reapSessionRecord(records, 'new-exit')
    expect(records.has('exit-1')).toBe(true)
    expect(records.size).toBe(MAX_EXIT_RECEIPTS * 2 + 1)
    for (let i = 0; i < MAX_EXIT_RECEIPTS + 1; i++) {
      expect(records.has(`live-${i}`)).toBe(true)
    }
  })

  it('does not evict evidence when reaping an explicitly killed process', () => {
    const records = new Map<string, TerminalHostSessionRecord>()
    fillReceipts(records)
    const killed = session('killed')
    Object.assign(killed, { killRequested: true })
    records.set('killed', killed)
    reapSessionRecord(records, 'killed')
    expect(records.size).toBe(MAX_EXIT_RECEIPTS)
    expect(records.has('exit-0')).toBe(true)
    expect(records.has('killed')).toBe(false)
  })
})
