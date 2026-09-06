import { describe, expect, it } from 'vitest'
import type { RoomParticipant } from '../../../shared/rooms'
import { extractRoomReplyRecipients } from './mentions'

const participants = [
  { actorKind: 'agent', identity: 'codex' },
  { actorKind: 'agent', identity: 'claude' },
  { actorKind: 'user', identity: 'user' }
] as RoomParticipant[]

describe('room reply recipients', () => {
  it('routes only a valid structured footer', () => {
    expect(extractRoomReplyRecipients('Discuss @codex in prose.', participants, 'claude')).toEqual({
      body: 'Discuss @codex in prose.',
      mentions: [],
      silent: false
    })
    expect(
      extractRoomReplyRecipients(
        'Done.\n<orca-room-recipients>["codex"]</orca-room-recipients>',
        participants,
        'claude'
      )
    ).toEqual({ body: 'Done.', mentions: ['codex'], silent: false })
    expect(
      extractRoomReplyRecipients(
        'Done.\n<orca-room-recipients>["user","missing","codex","CLAUDE","claude"]</orca-room-recipients>',
        participants,
        'codex'
      )
    ).toEqual({ body: 'Done.', mentions: ['claude'], silent: false })
    expect(
      extractRoomReplyRecipients(
        'Done.\n<orca-room-recipients>not-json</orca-room-recipients>',
        participants,
        'codex'
      )
    ).toEqual({ body: 'Done.', mentions: [], silent: false })
  })

  it('accepts only an otherwise empty silent acknowledgement', () => {
    expect(extractRoomReplyRecipients('<orca-room-silent />', participants, 'codex')).toEqual({
      body: '',
      mentions: [],
      silent: true
    })
    expect(
      extractRoomReplyRecipients(
        'Useful answer.\n<orca-room-silent />\n<orca-room-recipients>["claude"]</orca-room-recipients>',
        participants,
        'codex'
      )
    ).toEqual({ body: 'Useful answer.', mentions: ['claude'], silent: false })
  })

  it('does not publish or route a recipients-only footer', () => {
    expect(
      extractRoomReplyRecipients(
        '<orca-room-recipients>["claude"]</orca-room-recipients>',
        participants,
        'codex'
      )
    ).toEqual({ body: '', mentions: [], silent: true })
  })
})
