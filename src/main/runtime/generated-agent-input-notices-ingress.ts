import { z } from 'zod'
import { TerminalSendGeneratedInputParams } from '../../shared/rpc-contract/generated-input-params'
import { isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { readTerminalSendAcknowledgment } from '../../shared/terminal/pty/lifecycle/terminal-send-acknowledgment'
import { GeneratedInputParts } from './rpc/methods/terminal/generated-input-parts'
import type {
  GeneratedAgentInputNotices,
  GeneratedInputNoticeOwner
} from './generated-agent-input-notices'

/** Follows one accepted request out of this process: `dispatched` when the transport is about to
 *  send it, `answered` with the host's answer (null when it was lost). */
export type GeneratedInputReplyObserver = {
  dispatched: () => void
  answered: (response: RuntimeRpcResponse<unknown> | null) => void
}

// The host refused the request before staging or writing any of it: another runtime now answers.
const refusedSchema = z.object({ refused: z.literal('runtime-changed') })

const stagedSchema = z.object({ part: z.literal('accepted') })

const replySchema = z.object({
  delivery: z.object({
    outcome: z.enum(['delivered', 'staged', 'not-sent', 'unconfirmed', 'target-gone']),
    noticeRetained: z.literal(true).optional()
  })
})

/** Where a window's generated request enters this runtime's process, local or bound for a paired
 *  host. The request's own text becomes this window's pending record, not sent, before anything
 *  about the send is awaited, so no reload in between can lose it or call it sent; nothing here
 *  can delay or refuse the send. The host's answer then settles the record without the window's
 *  renderer. */
export class GeneratedInputIngress {
  // A large request to a paired host arrives in parts; its record needs the whole text.
  private readonly parts = new GeneratedInputParts()

  constructor(private readonly notices: GeneratedAgentInputNotices) {}

  accept(
    method: string,
    params: unknown,
    from: { origin: string; connection: string },
    owner?: GeneratedInputNoticeOwner,
    /** Local only: the window's accepted request, for a host that keeps no notice by id. */
    operationId?: string
  ): GeneratedInputReplyObserver | null {
    if (method !== 'terminal.sendGeneratedInput') {
      return null
    }
    const parsed = TerminalSendGeneratedInputParams.safeParse(params)
    const retains = parsed.success && parsed.data.retainNotice === true && !!parsed.data.operationId
    const id = retains ? parsed.data!.operationId! : operationId
    if (!parsed.success || !id) {
      return null
    }
    const { text: _text, part: _part, timeoutMs: _timeout, ...request } = parsed.data
    let text: string
    try {
      // Every part names the same request and the same host receipt.
      const binding = JSON.stringify([request, owner ?? null, id])
      const staged = this.parts.accept(from.connection, parsed.data, binding)
      if (staged.kind === 'pending') {
        return this.notices.belongsTo(id, from.origin) ? followStaging(this.notices, id) : null
      }
      text = staged.text
    } catch {
      // The host refuses the same malformed upload; the window's own record still holds the text.
      return null
    }
    // An older host keeps no notice by id: this window's own record follows the final frame.
    if (!retains) {
      return this.notices.belongsTo(id, from.origin)
        ? followGeneratedInputFrame(this.notices, id, (response) =>
            this.answered(id, from.origin, response)
          )
        : null
    }
    // A qualified target names the runtime that alone may run it: that is the host receipt.
    const qualified = typeof request.terminal === 'object' ? request.terminal : null
    const handle =
      qualified?.handle ?? (typeof request.terminal === 'string' ? request.terminal : '')
    const { retained } = this.notices.upsert({
      id,
      origin: from.origin,
      pending: true,
      connection: from.connection,
      text,
      agent: request.agent && isTuiAgent(request.agent) ? request.agent : null,
      certainty: 'not-sent',
      ...(request.submit ? {} : { submitted: false }),
      handle: '',
      worktreeId: '',
      ptyId: request.ptyId ?? null,
      ...(owner
        ? {
            owner: {
              ...owner,
              ...(qualified ? { runtimeId: qualified.expectedRuntimeId } : {}),
              ...(request.window ? { window: request.window } : {}),
              ...(handle ? { terminal: handle } : {})
            }
          }
        : {})
    })
    if (!retained || !owner) {
      return null
    }
    return followGeneratedInputFrame(this.notices, id, (response) =>
      this.answered(id, from.origin, response)
    )
  }

  // The host's own outcome for the final frame, which settles or proves the same record.
  private answered(
    id: string,
    origin: string,
    response: Extract<RuntimeRpcResponse<unknown>, { ok: true }>
  ): 'refused' | 'unknown' | null {
    const reply = replySchema.safeParse(response.result)
    if (refusedSchema.safeParse(response.result).success) {
      return 'refused'
    }
    if (!reply.success) {
      return 'unknown'
    }
    const { outcome, noticeRetained } = reply.data.delivery
    this.notices.hostAnswered(
      id,
      origin,
      outcome === 'delivered' || outcome === 'staged'
        ? { kind: 'delivered' }
        : noticeRetained
          ? { kind: 'retained', runtimeId: response._meta.runtimeId }
          : {
              kind: 'failed',
              certainty: outcome === 'unconfirmed' ? 'unconfirmed' : 'not-sent',
              targetGone: outcome === 'target-gone'
            }
    )
    return null
  }
}

// A part before the last only stages text on the host; it can execute nothing. An upload that
// ends there, refused or unanswered, never issued its final request, so nothing was sent.
function followStaging(
  notices: GeneratedAgentInputNotices,
  id: string
): GeneratedInputReplyObserver {
  let answered = false
  return {
    dispatched: () => {},
    answered: (response) => {
      if (answered) {
        return
      }
      answered = true
      if (!response?.ok || stagedSchema.safeParse(response.result).success === false) {
        notices.frameSettled(id, 'refused')
      }
    }
  }
}

/** A frame of an older host's write of a window's accepted request, on its way out: its handoff
 *  and its answer settle the same record. Null when it names no request of that window. */
export function followLegacyGeneratedInputWrite(
  notices: GeneratedAgentInputNotices,
  operationId: string,
  origin: string
): GeneratedInputReplyObserver | null {
  if (!notices.belongsTo(operationId, origin)) {
    return null
  }
  return followGeneratedInputFrame(notices, operationId, (response) => {
    const acknowledgment = readTerminalSendAcknowledgment(response.result)
    return acknowledgment === 'unverifiable' ? 'unknown' : acknowledgment
  })
}

/** One local or SSH terminal write of a window's accepted request: handed to the terminal's
 *  provider, then taken, refused, or unknown. Null when it names no request of that window. */
export function followLocalGeneratedInputWrite(
  notices: GeneratedAgentInputNotices,
  operationId: string,
  origin: string
): { handedOff: () => void; settled: (result: 'accepted' | 'refused' | 'unknown') => void } | null {
  if (!notices.belongsTo(operationId, origin)) {
    return null
  }
  let handedOff = false
  return {
    handedOff: () => {
      handedOff = true
      notices.dispatched(operationId)
    },
    // Refused before the provider saw it, the write could not have been taken.
    settled: (result) => notices.frameSettled(operationId, handedOff ? result : 'refused')
  }
}

// One frame's life: handed off (possibly sent), then answered. An end before the handoff proves
// nothing was sent; a lost or unreadable answer after it leaves the request possibly sent.
function followGeneratedInputFrame(
  notices: GeneratedAgentInputNotices,
  id: string,
  settle: (
    response: Extract<RuntimeRpcResponse<unknown>, { ok: true }>
  ) => 'accepted' | 'refused' | 'unknown' | null
): GeneratedInputReplyObserver {
  let answered = false
  let dispatched = false
  return {
    dispatched: () => {
      dispatched = true
      notices.dispatched(id)
    },
    answered: (response) => {
      if (answered) {
        return
      }
      answered = true
      if (!dispatched) {
        notices.frameSettled(id, 'refused')
        return
      }
      const settled = response?.ok ? settle(response) : 'unknown'
      if (settled) {
        notices.frameSettled(id, settled)
      }
    }
  }
}
