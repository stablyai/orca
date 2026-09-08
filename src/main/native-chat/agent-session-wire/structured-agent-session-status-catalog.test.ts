import { describe, expect, it } from 'vitest'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { createHostStatusFeed } from './structured-agent-session-status-catalog'

describe('status catalog completeness', () => {
  it.each([
    { present: true, readOnly: false, recoveredFromBackup: false, complete: true },
    { present: false, readOnly: false, recoveredFromBackup: false, complete: false },
    { present: true, readOnly: true, recoveredFromBackup: false, complete: false },
    { present: true, readOnly: false, recoveredFromBackup: true, complete: false }
  ])('keeps startup authority conservative: %o', (input) => {
    let present = input.present
    const store = {
      readOnly: input.readOnly,
      recoveredFromBackup: input.recoveredFromBackup,
      getVisibleSessionTabIndex: () => ({ present, sessionIds: ['still-restoring'] }),
      listVisibleSessionIds: () => ['still-restoring']
    } as unknown as AgentSessionRecordStore
    const feed = createHostStatusFeed(
      { store } as StructuredAgentSessionHostDeps,
      new Map(),
      () => 1
    )
    present = true
    const events: AgentSessionStatusEvent[] = []
    feed.subscribe({ id: 'reader', emit: (event) => events.push(event) })
    expect(events).toEqual([
      {
        type: 'snapshot',
        sessions: [],
        catalog: {
          epoch: expect.any(String),
          complete: input.complete,
          sessionIds: ['still-restoring']
        }
      }
    ])
  })
})
