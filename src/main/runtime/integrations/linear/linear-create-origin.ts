import { isLinearUuid } from '../../../../shared/linear/uuid'
import { linearError } from '../../../linear/issues/context/linear-access-errors'

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
  const question =
    '起票を保留しました。元の依頼が対象とする案件と、引き受けるPMを確認してください。'
  if (!authority?.requestId.trim() || !authority.replyTo.trim()) {
    throw linearError('linear_permission_denied', `${question} 依頼元を未特定です。`)
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
    throw linearError('linear_permission_denied', `${question} 依頼元への確認は配送未確認です。`)
  }
  throw linearError('linear_permission_denied', question)
}
