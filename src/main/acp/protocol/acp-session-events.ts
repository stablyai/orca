import { z } from 'zod'
import { getCompiledSchema } from '../../schema-validation/zod-schema-compilation'
import {
  SessionNotificationSchema,
  type SessionNotification
} from '../generated/acp-protocol.generated'

export const acpNotificationEnvelopeSchema = z.looseObject({
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() }),
  _meta: z.looseObject({ isReplay: z.boolean().optional() }).nullish()
})

const updateEnvelopeSchema = z.looseObject({
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() })
})

export type AcpSessionEvent =
  | { kind: 'known'; notification: SessionNotification }
  | { kind: 'unrecognized'; sessionId: string; raw: z.infer<typeof updateEnvelopeSchema> }

/** Preserve unknown updates; reject malformed envelopes. */
export function readAcpSessionEvent(params: unknown): AcpSessionEvent | null {
  const envelope = updateEnvelopeSchema.safeParse(params)
  if (!envelope.success) {
    return null
  }
  const parsed = getCompiledSchema(SessionNotificationSchema).safeParse(params)
  return parsed.success
    ? { kind: 'known', notification: parsed.data }
    : { kind: 'unrecognized', sessionId: envelope.data.sessionId, raw: envelope.data }
}

const extensionSessionSchema = z.looseObject({ sessionId: z.string() })

/** Route an incoming or synthesized ACP notification frame to session listeners or the extension handler. */
export function deliverAcpNotificationFrame(
  method: string,
  params: unknown,
  listeners: ReadonlySet<(event: AcpSessionEvent) => void>,
  onExtension: ((method: string, params: unknown) => void) | undefined,
  diagnose: (message: string) => void,
  state: { reportedAnomaly: boolean },
  startedSessionId?: string
): void {
  if (method !== 'session/update') {
    const extSession = extensionSessionSchema.safeParse(params)
    if (
      extSession.success &&
      (!startedSessionId || extSession.data.sessionId !== startedSessionId)
    ) {
      return
    }
    try {
      onExtension?.(method, params)
    } catch (error) {
      diagnose(`ACP extension listener failed: ${String(error)}`)
    }
    return
  }
  const event = readAcpSessionEvent(params)
  if (!event) {
    diagnose('Ignored invalid ACP session update envelope')
    return
  }
  if (event.kind === 'unrecognized' && !state.reportedAnomaly) {
    state.reportedAnomaly = true
    diagnose('Forwarded unrecognized ACP session update')
  }
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (error) {
      diagnose(`ACP event listener failed: ${String(error)}`)
    }
  }
}
