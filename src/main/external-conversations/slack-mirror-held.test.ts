// A mirrored turn's end held behind the owner's posts keeps whom it acts for, as decided when the
// turn ended, through the link it is saved on and onto the wire the cloud reads.
import { describe, expect, it } from 'vitest'
import type { ConnectorTurnFor } from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { toConnectorEvent } from '../connector-cloud/connector-event-wire'
import { releaseHeldTurnEnds, withHeldTurnEnd, type ConversationTurnEnd } from './slack-mirror-held'

const end = (turnFor?: ConnectorTurnFor): ConversationTurnEnd => ({
  kind: 'turn-ended',
  conversation: { source: 'slack', externalId: 'T1:C1:1712.1:UBOT' },
  worktreeId: 'w',
  paneKey: 'pane',
  turnId: 7,
  stopReason: 'success',
  at: 1,
  lastAssistantMessage: 'done',
  origin: 'local',
  mirror: true,
  ...(turnFor ? { turnFor } : {})
})

/** Held behind the owner's post, saved and read back as the link is, then released when it lands. */
function heldThenReleased(event: ConversationTurnEnd) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a link with only the fields the hold reads.
  const link = {} as ExternalConversationLink
  const saved: ExternalConversationLink = JSON.parse(
    JSON.stringify(withHeldTurnEnd(link, event, ['post-1']))
  )
  const { ready } = releaseHeldTurnEnds(saved, 'post-1')
  expect(ready).toHaveLength(1)
  return toConnectorEvent(ready[0]!, new Set())
}

describe('a held mirrored turn end', () => {
  it('goes out saying whom it acts for, as an end sent right away does', () => {
    for (const turnFor of ['owner', 'someone_else'] as const) {
      const now = toConnectorEvent(end(turnFor), new Set())
      expect(now).toMatchObject({ turnFor })
      expect(heldThenReleased(end(turnFor))).toMatchObject({ turnFor })
    }
  })

  it('still reads one saved before it said, saying nothing', () => {
    const released = heldThenReleased(end())
    expect(released).not.toBeNull()
    expect(released).not.toHaveProperty('turnFor')
  })
})
