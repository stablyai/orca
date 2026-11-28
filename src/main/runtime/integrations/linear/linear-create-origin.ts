import { isLinearUuid } from '../../../../shared/linear/uuid'
import { englishTranslate } from '../../../../shared/i18n/english-translate'
import { linearError } from '../../../linear/issues/context/linear-access-errors'
import { getRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'

type Project = { workspaceId: string; projectId: string }
type Receipt = { botId: string; project: Project }
export type CreateOrigin = {
  requestId: string
  receivingBotId: string
  original: Project | null
  assignment: Receipt | null
}

// Supplied by the host for this individual request, never by Linear command parameters.
export type LinearCreateAuthority = {
  readonly requestId: string
  readonly replyTo: string
  stillCurrent?: () => Promise<boolean>
  readCurrent: () => Promise<CreateOrigin | null>
  askOriginOnce: (
    message: string
  ) => Promise<{ requestId: string; destination: string; messageId: string }>
}

export async function checkLinearCreateOrigin(
  authority: LinearCreateAuthority | null | undefined,
  workspaceId: string,
  projectId?: string | null
) {
  const origin = await authority?.readCurrent().catch(() => null)
  const assignment = origin?.assignment
  if (
    authority?.requestId.trim() &&
    authority.replyTo.trim() &&
    origin?.requestId === authority.requestId &&
    assignment &&
    origin.original &&
    projectId &&
    isLinearUuid(projectId) &&
    isLinearUuid(workspaceId) &&
    isLinearUuid(origin.receivingBotId) &&
    assignment.botId === origin.receivingBotId &&
    assignment.project.workspaceId === workspaceId &&
    origin.original.workspaceId === workspaceId &&
    assignment.project.projectId === projectId &&
    origin.original.projectId === projectId
  ) {
    return {
      current: async () => (await authority.stillCurrent?.().catch(() => false)) === true,
      refused: () => refuseCreate(authority)
    }
  }
  return refuseCreate(authority)
}

async function refuseCreate(authority: LinearCreateAuthority | null | undefined): Promise<never> {
  const t = getRuntimeDesktopSurface().translateNotification ?? englishTranslate
  const question = t(
    'runtimeRpc.linearCreateOrigin.question',
    'Issue creation is on hold. Please confirm the project for the original request and the PM responsible for it.'
  )
  if (!authority?.requestId.trim() || !authority.replyTo.trim()) {
    throw linearError(
      'linear_permission_denied',
      t(
        'runtimeRpc.linearCreateOrigin.unknownOrigin',
        '{{question}} The request origin could not be identified.',
        { question }
      )
    )
  }
  try {
    const sent = await authority.askOriginOnce(question)
    if (
      sent.requestId !== authority.requestId ||
      sent.destination !== authority.replyTo ||
      !sent.messageId.trim()
    ) {
      throw new Error('Origin delivery unconfirmed')
    }
  } catch {
    throw linearError(
      'linear_permission_denied',
      t(
        'runtimeRpc.linearCreateOrigin.unconfirmedDelivery',
        '{{question}} Delivery of this question to the requester is unconfirmed.',
        { question }
      )
    )
  }
  throw linearError('linear_permission_denied', question)
}
