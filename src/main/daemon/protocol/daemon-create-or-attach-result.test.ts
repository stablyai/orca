import { describe, expect, it } from 'vitest'
import { SessionLaunchNote } from '../sessions/session-launch-note'
import { getDaemonSessionResultMetadata } from './daemon-create-or-attach-result'

const NOTE = { launchToken: 'launch-1', launchConfig: { agentArgs: '', agentEnv: {} } }

function reattachMetadata(launchNote: SessionLaunchNote) {
  return getDaemonSessionResultMetadata({
    launchAgent: 'claude',
    launchNote,
    historySeeded: undefined,
    wslDistro: null
  })
}

describe('daemon reattach metadata', () => {
  it('names the launched agent until main retires its launch', () => {
    const note = new SessionLaunchNote()
    note.change({ arm: NOTE })
    expect(reattachMetadata(note)).toMatchObject({ launchAgent: 'claude', launchNote: NOTE })

    // Why: after the agent exits the terminal keeps running other programs (vim, ssh, a shell).
    note.change({ retire: 'launch-1' })
    expect(reattachMetadata(note)).toEqual({ launchNote: null, wslDistro: null })
  })

  it('names the agent of a launch main never armed', () => {
    expect(reattachMetadata(new SessionLaunchNote())).toMatchObject({ launchAgent: 'claude' })
  })
})
