import { z } from 'zod'
import { BoundedMap } from '../../../shared/bounded-map'
import type { AgentJournalUrlApprovalSubject } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import {
  isUrlApprovalSubject,
  readApprovalUrl,
  URL_APPROVAL_DECLINE_OPTION_ID,
  URL_APPROVAL_OPEN_OPTION_ID
} from '../../../shared/agent-session/agent-session-approval-subject'
import {
  pendingAcpResolution,
  type AcpDialect,
  type AcpRequestPresentation
} from '../acp-dialects/acp-dialect'
import { AcpRpcError } from '../transport/acp-errors'

// Longer than any sign-in link; a URL the card cannot show whole is refused.
const MAX_URL_LENGTH = 8 * 1024

const urlSchema = z.object({
  mode: z.literal('url'),
  message: z.string(),
  elicitationId: z.string().min(1),
  url: z.string().max(MAX_URL_LENGTH)
})
const completeSchema = z.object({ elicitationId: z.string().min(1) })

export function isAcpUrlElicitation(params: unknown): boolean {
  return z.object({ mode: z.literal('url') }).safeParse(params).success
}

type UrlRequestAction = 'accept' | 'decline' | 'cancel'

/** A page the agent asks the person to open, such as an MCP server's sign-in. Only http(s) is shown.
 *  `answer` writes the action in the agent's reply shape; ACP's is `{ action }`. */
export function acpUrlElicitationPresentation(
  params: unknown,
  answer: (action: UrlRequestAction) => unknown = (action) => ({ action })
): AcpRequestPresentation & { elicitationId: string } {
  const parsed = urlSchema.safeParse(params)
  const url = parsed.success ? readApprovalUrl(parsed.data.url) : null
  if (!parsed.success || !url) {
    throw new AcpRpcError(-32602, 'Unsupported ACP elicitation URL')
  }
  const { message, elicitationId } = parsed.data
  return {
    elicitationId,
    body: {
      kind: 'approval',
      title: 'Sign-in requested',
      ...(message.trim() ? { description: message } : {}),
      subject: { kind: 'url', url: url.href },
      // Another agent must not consent to a person's sign-in.
      personOnly: true,
      detail: null,
      options: [
        { id: URL_APPROVAL_OPEN_OPTION_ID, label: 'Open sign-in page' },
        { id: URL_APPROVAL_DECLINE_OPTION_ID, label: 'Decline' }
      ],
      resolution: pendingAcpResolution
    },
    // `accept` means the person opened the page, not that the work there finished.
    reply: (response) => {
      if (response === null) {
        return answer('cancel')
      }
      if (response.kind === 'option' && response.optionId === URL_APPROVAL_OPEN_OPTION_ID) {
        return answer('accept')
      }
      if (response.kind === 'option' && response.optionId === URL_APPROVAL_DECLINE_OPTION_ID) {
        return answer('decline')
      }
      throw new AcpRpcError(-32602, 'URL request answer must open or decline')
    }
  }
}

type TrackedUrlRequest = {
  request: string
  subject: AgentJournalUrlApprovalSubject
  answered: boolean
  completedAt?: number
}

/** URL requests by elicitation ID, until the agent reports them finished and the person has answered. */
export class AcpUrlElicitations {
  private readonly open = new BoundedMap<string, TrackedUrlRequest>({ maxEntries: 64 })

  track<
    T extends { events: readonly ProviderTimelineEvent[]; presentation?: AcpRequestPresentation }
  >(translated: T): T {
    const elicitationId = translated.presentation?.elicitationId
    const opened = translated.events.find((event) => event.type === 'request.open')
    if (
      elicitationId &&
      opened?.type === 'request.open' &&
      opened.body.kind === 'approval' &&
      isUrlApprovalSubject(opened.body.subject)
    ) {
      this.open.set(elicitationId, {
        request: opened.request,
        subject: opened.body.subject,
        answered: false
      })
    }
    return translated
  }

  /** ACP's completion, or the agent's own name for it. */
  completes(method: string, dialect: AcpDialect): boolean {
    return method === 'elicitation/complete' || dialect.elicitationComplete?.(method) === true
  }

  /** Unknown and already-finished IDs are ignored, as the protocol requires. */
  complete(params: unknown, at: number): ProviderTimelineEvent[] {
    const parsed = completeSchema.safeParse(params)
    const entry = parsed.success ? this.open.get(parsed.data.elicitationId) : undefined
    if (!parsed.success || !entry || entry.completedAt !== undefined) {
      return []
    }
    entry.completedAt = at
    // Before the answer is saved the card is still pending; `answered` writes it then.
    return entry.answered ? this.finish(parsed.data.elicitationId, entry) : []
  }

  /** The person's answer to `request` is saved; a completion that came first now applies. */
  answered(request: string): ProviderTimelineEvent[] {
    for (const [elicitationId, entry] of this.open.entries()) {
      if (entry.request === request) {
        entry.answered = true
        return entry.completedAt === undefined ? [] : this.finish(elicitationId, entry)
      }
    }
    return []
  }

  private finish(elicitationId: string, entry: TrackedUrlRequest): ProviderTimelineEvent[] {
    this.open.delete(elicitationId)
    return [
      {
        type: 'request.subject',
        request: entry.request,
        subject: { ...entry.subject, completedAt: entry.completedAt }
      }
    ]
  }
}
