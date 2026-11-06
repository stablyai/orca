import { describe, expect, it } from 'vitest'
import { SessionLaunchNote } from '../session-launch-note'

const NOTE = { launchToken: 'launch-1', launchConfig: { agentArgs: '--verbose', agentEnv: {} } }
const NEXT = { launchToken: 'launch-2', launchConfig: { agentArgs: '', agentEnv: {} } }

// The launch can finish while main is down, so the daemon must retire the note without main.
describe('a daemon session launch note', () => {
  it('retires when the launched command finishes, even across a same-launch re-arm', () => {
    const note = new SessionLaunchNote()
    note.change({ arm: NOTE })
    note.scan('agent output\x1b]133;')
    note.change({ arm: NOTE })
    expect(note.current).toEqual(NOTE)
    note.scan('D;143\x07')
    expect(note.current).toBeNull()
  })

  it('ignores a retire for an earlier launch', () => {
    const note = new SessionLaunchNote()
    note.change({ arm: NOTE })
    note.change({ arm: NEXT })
    note.change({ retire: 'launch-1' })
    expect(note.current).toEqual(NEXT)
  })
})
