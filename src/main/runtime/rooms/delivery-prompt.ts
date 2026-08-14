import type { RoomMessage, RoomParticipant } from '../../../shared/rooms'
import type { RoomDeliveryConfiguration } from './delivery-configuration'

export type RoomDeliveryResponse = 'required' | 'optional'

export function roomDeliveryAttemptsFromTurn(
  turnText: string
): { deliveryId: string; attempt: number | null }[] {
  return [...turnText.matchAll(/<orca-room-delivery\b([^>]*)>/g)].flatMap(([, attributes]) => {
    const deliveryId = attributes?.match(/\bid="([^"]+)"/)?.[1]
    if (!deliveryId) {
      return []
    }
    const attempt = attributes.match(/\battempt="(\d+)"/)?.[1]
    return [{ deliveryId, attempt: attempt === undefined ? null : Number(attempt) }]
  })
}

export function formatRoomDeliveryPrompt(input: {
  deliveryId: string
  attempt: number
  response: RoomDeliveryResponse
  roomName: string
  message: RoomMessage
  replyParent: RoomMessage | null
  target: RoomParticipant
  participants: RoomParticipant[]
  configuration: RoomDeliveryConfiguration
  attachmentPaths: ReadonlyMap<string, string>
}): string {
  const participantList = input.participants
    .filter((participant) => participant.id !== input.target.id)
    .map(formatParticipantIdentity)
    .join(', ')
  const replyRecipients = input.participants
    .filter(
      (participant) =>
        participant.actorKind === 'agent' &&
        participant.participation === 'active' &&
        participant.id !== input.target.id
    )
    .map((participant) => participant.identity)
  const configuration = formatConfiguration(input.configuration)
  const protocol =
    input.response === 'required'
      ? 'A reply is required.'
      : 'Reply only when you can add useful, relevant information or your role requires it; otherwise return exactly <orca-room-silent />.'
  const body = [
    `You are ${formatParticipantIdentity(input.target)} in the Orca room "${escapeXml(input.roomName)}".`,
    participantList ? `Other participants: ${participantList}.` : '',
    configuration,
    `${protocol} To invite agent replies, append <orca-room-recipients>["identity"]</orca-room-recipients> using only identities from ${escapeXml(JSON.stringify(replyRecipients))}; never include "user" (the user sees every reply). @mentions alone do not route.`,
    input.replyParent
      ? `Direct reply context:\n${formatMessage(input.replyParent, input.attachmentPaths, 'room-reply-parent')}`
      : '',
    `Current message:\n${formatMessage(input.message, input.attachmentPaths, 'room-message')}`
  ]
    .filter(Boolean)
    .join('\n\n')
  return `${roomDeliveryMarker(input.deliveryId, input.response, input.attempt)}\n${body}\n</orca-room-delivery>`
}

function formatParticipantIdentity(participant: RoomParticipant): string {
  return `${escapeXml(participant.displayName)} (@${escapeXml(participant.identity)})`
}

export function roomDeliveryMarker(
  deliveryId: string,
  response: RoomDeliveryResponse = 'required',
  attempt?: number
): string {
  return `<orca-room-delivery id="${deliveryId}" response="${response}"${attempt === undefined ? '' : ` attempt="${attempt}"`}>`
}

function formatConfiguration(configuration: RoomDeliveryConfiguration): string {
  const fields: string[] = []
  if (configuration.description) {
    fields.push(`Description:\n${escapeXml(configuration.description)}`)
  }
  if (configuration.role) {
    fields.push(
      `Role:\n${escapeXml(configuration.role.name)}${configuration.role.prompt ? `\n${escapeXml(configuration.role.prompt)}` : ''}`
    )
  }
  for (const field of configuration.cleared ?? []) {
    fields.push(`${field[0]!.toUpperCase()}${field.slice(1)} cleared.`)
  }
  return fields.length > 0 ? `Room configuration update:\n${fields.join('\n\n')}` : ''
}

function formatMessage(
  message: RoomMessage,
  attachmentPaths: ReadonlyMap<string, string>,
  tag: 'room-message' | 'room-reply-parent'
): string {
  const attachments = message.attachments
    .map((attachment) => {
      const path = attachmentPaths.get(attachment.id)
      if (!path) {
        throw new Error('room_attachment_stage_missing')
      }
      return `<attachment name="${escapeXmlAttribute(attachment.fileName)}" path="${escapeXmlAttribute(path)}" />`
    })
    .join('\n')
  return `<${tag} sender="@${escapeXmlAttribute(message.senderIdentity)}">\n${escapeXml(message.body)}${attachments ? `\n<attachments>\n${attachments}\n</attachments>` : ''}\n</${tag}>`
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeXmlAttribute(value: string): string {
  return escapeXml(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}
