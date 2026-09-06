import type { RoomParticipant } from '../../../shared/rooms'

const RECIPIENTS_BLOCK = /\n?<orca-room-recipients>([^\n]*)<\/orca-room-recipients>\s*$/u
const SILENT_BLOCK = /\n?<orca-room-silent\s*\/>\s*$/u

export function extractRoomReplyRecipients(
  body: string,
  participants: RoomParticipant[],
  senderIdentity: string
): { body: string; mentions: string[]; silent: boolean } {
  const match = body.match(RECIPIENTS_BLOCK)
  if (!match) {
    return stripSilentBlock(body, [])
  }
  try {
    const requested: unknown = JSON.parse(match[1] ?? '')
    if (!Array.isArray(requested) || !requested.every((identity) => typeof identity === 'string')) {
      return stripSilentBlock(body.slice(0, match.index).trimEnd(), [])
    }
    const sender = senderIdentity.toLocaleLowerCase()
    const allowed = new Map(
      participants
        .filter(
          (participant) =>
            participant.actorKind === 'agent' && participant.identity.toLocaleLowerCase() !== sender
        )
        .map((participant) => [participant.identity.toLocaleLowerCase(), participant.identity])
    )
    const mentions = [
      ...new Set(
        requested
          .map((identity) => allowed.get(identity.trim().toLocaleLowerCase()))
          .filter((identity): identity is string => Boolean(identity))
      )
    ]
    return stripSilentBlock(body.slice(0, match.index).trimEnd(), mentions)
  } catch {
    return stripSilentBlock(body.slice(0, match.index).trimEnd(), [])
  }
}

function stripSilentBlock(
  body: string,
  mentions: string[]
): { body: string; mentions: string[]; silent: boolean } {
  const match = body.match(SILENT_BLOCK)
  const visibleBody = (match ? body.slice(0, match.index) : body).trimEnd()
  return visibleBody.trim()
    ? { body: visibleBody, mentions, silent: false }
    : { body: '', mentions: [], silent: true }
}

export function validateRoomMentions(
  requested: string[],
  participants: RoomParticipant[]
): string[] {
  const identities = new Map(
    participants
      .filter((participant) => participant.actorKind === 'agent')
      .map((participant) => [participant.identity.toLocaleLowerCase(), participant.identity])
  )
  const mentions = [...new Set(requested.map((identity) => identity.trim()).filter(Boolean))]
  return mentions.map((identity) => {
    const canonical = identities.get(identity.toLocaleLowerCase())
    if (!canonical) {
      throw new Error(`room_mention_not_found:${identity}`)
    }
    return canonical
  })
}
