import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  isBindingDurable,
  recordDurableBinding,
  type DurableBindingRecords
} from './pty-binding-durability-records'

const PANE = 'tab1:leaf1'

function seeded(): {
  records: DurableBindingRecords
  session: ReturnType<typeof getDefaultWorkspaceSession>
} {
  const records: DurableBindingRecords = new Map()
  const session = getDefaultWorkspaceSession()
  recordDurableBinding(records, PANE, {
    session,
    ptyId: 'pty-1',
    incarnationId: 'inc-1',
    generation: 5
  })
  return { records, session }
}

describe('durable binding records', () => {
  it('accepts the recorded binding once its generation is durable', () => {
    const { records, session } = seeded()
    expect(isBindingDurable(records, PANE, session, 'pty-1', 'inc-1', 5)).toBe(true)
    expect(isBindingDurable(records, PANE, session, 'pty-1', 'inc-1', 9)).toBe(true)
    expect(isBindingDurable(records, PANE, session, 'pty-1', 'inc-1', 4)).toBe(false)
  })

  it('retires the record when the session object is replaced', () => {
    const { records } = seeded()
    expect(isBindingDurable(records, PANE, getDefaultWorkspaceSession(), 'pty-1', 'inc-1', 9)).toBe(
      false
    )
  })

  it('rejects a different pty, incarnation, or pane', () => {
    const { records, session } = seeded()
    expect(isBindingDurable(records, PANE, session, 'pty-2', 'inc-1', 9)).toBe(false)
    expect(isBindingDurable(records, PANE, session, 'pty-1', 'inc-2', 9)).toBe(false)
    expect(isBindingDurable(records, PANE, session, 'pty-1', undefined, 9)).toBe(false)
    expect(isBindingDurable(records, 'other:pane', session, 'pty-1', 'inc-1', 9)).toBe(false)
  })

  it('bounds growth by clearing rather than tracking recency', () => {
    const records: DurableBindingRecords = new Map()
    const session = getDefaultWorkspaceSession()
    for (let i = 0; i < 5000; i++) {
      recordDurableBinding(records, `tab:${i}`, {
        session,
        ptyId: 'pty',
        incarnationId: undefined,
        generation: 1
      })
    }
    expect(records.size).toBeLessThanOrEqual(4096)
    expect(isBindingDurable(records, 'tab:4999', session, 'pty', undefined, 1)).toBe(true)
  })
})
