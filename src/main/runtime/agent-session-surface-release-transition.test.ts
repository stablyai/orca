import { describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { releaseAgentSessionOwnerAfterSurfaceClose } from './agent-session-surface-release-transition'

describe('agent session surface release transition', () => {
  it('honours a recovery floor when releasing the owner', () => {
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({ runtimeKind: 'native', minimumNextFence: 9 })
    )

    const released = releaseAgentSessionOwnerAfterSurfaceClose({
      record,
      expectedFence: 7,
      now: 1_800_000_001_000
    })

    expect(released.lease.runtimeFence).toBe(9)
  })
})
