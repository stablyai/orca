import { describe, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session-provider-handle'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { ProviderHistoryWindow } from '../agent-session-journal/journal-submission-reconciler'
import {
  resumePointStart,
  sampleProviderHistoryWindow
} from './structured-agent-session-history-sample'

const RECORD = agentSessionRecordFixture()
const IDENTITY = {
  sessionId: RECORD.sessionId,
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'claude',
  providerHandle: RECORD.providerHandleChain[0]!.handle
}
const WINDOW: ProviderHistoryWindow = { items: [], boundaryConsistent: true, turnInFlight: false }

function link(fence: number, leaf: string, observedAt: number): AgentSessionProviderHandleLink {
  return {
    linkId: `link-${fence}`,
    origin: 'resumed',
    mintedAtFence: fence,
    observedAt,
    handle: claudeProviderHandle('provider-session-alpha-1', leaf)
  }
}

describe('resumePointStart', () => {
  it('dates the start from the link that set the head leaf, not from links that re-proved it', () => {
    expect(resumePointStart([link(3, 'a', 30), link(4, 'b', 40), link(5, 'b', 50)])).toEqual({
      fence: 4,
      movedAt: 40
    })
  })

  it('dates it from the head when the head moved the leaf', () => {
    expect(resumePointStart([link(3, 'a', 30), link(4, 'b', 40), link(5, 'c', 50)])).toEqual({
      fence: 5,
      movedAt: 50
    })
  })

  it('has no start without a chain', () => {
    expect(resumePointStart([])).toBeNull()
  })
})

describe('sampleProviderHistoryWindow', () => {
  const sample = (
    read: () => Promise<ProviderHistoryWindow | null>,
    ownerAlreadyAdmitted = false
  ) =>
    sampleProviderHistoryWindow({
      adapter: { providerHistoryWindow: read },
      identity: IDENTITY,
      record: { ...RECORD, providerHandleChain: [link(7, 'a', 70), link(8, 'a', 80)] },
      ownerAlreadyAdmitted
    })

  it('places the window at where its resume point was set', async () => {
    await expect(sample(async () => WINDOW)).resolves.toEqual({
      ...WINDOW,
      start: { fence: 7, movedAt: 70 }
    })
  })

  it('reads a live owner as a turn in flight', async () => {
    await expect(sample(async () => WINDOW, true)).resolves.toMatchObject({ turnInFlight: true })
  })

  it('has no window when the read fails or finds nothing', async () => {
    await expect(
      sample(async () => {
        throw new Error('transcript unreadable')
      })
    ).resolves.toBeNull()
    await expect(sample(async () => null)).resolves.toBeNull()
    await expect(
      sampleProviderHistoryWindow({
        adapter: {},
        identity: IDENTITY,
        record: RECORD,
        ownerAlreadyAdmitted: false
      })
    ).resolves.toBeNull()
  })
})
