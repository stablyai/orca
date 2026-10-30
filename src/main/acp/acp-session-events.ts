import type { AcpSessionRuntimeOptions } from './acp-session-runtime-options'
import { z } from 'zod'
import { getCompiledSchema } from '../zod-schema-compilation'
import {
  SessionNotificationSchema,
  type SessionNotification
} from './generated/acp-protocol.generated'

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

export class AcpSessionEvents {
  private readonly listeners = new Set<(event: AcpSessionEvent) => void>()
  private reportedUpdateAnomaly = false
  constructor(
    private readonly options: Pick<AcpSessionRuntimeOptions, 'onExtensionNotification'>,
    private readonly diagnose: (message: string) => void
  ) {}
  subscribe(listener: (event: AcpSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  clear(): void {
    this.listeners.clear()
  }

  handle(method: string, params: unknown): void {
    if (method !== 'session/update') {
      try {
        this.options.onExtensionNotification?.(method, params)
      } catch (error) {
        this.diagnose(`ACP extension listener failed: ${String(error)}`)
      }
      return
    }
    const event = readAcpSessionEvent(params)
    if (!event) {
      this.diagnose('Ignored invalid ACP session update envelope')
      return
    }
    if (event.kind === 'unrecognized' && !this.reportedUpdateAnomaly) {
      this.reportedUpdateAnomaly = true
      this.diagnose('Forwarded unrecognized ACP session update')
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.diagnose(`ACP event listener failed: ${String(error)}`)
      }
    }
  }
}
