import * as z from 'zod'
import { CONNECTOR_PROMPT_LIMITS } from '../../../src/shared/connector-prompt-contract'

const Target = z.object({
  sessionId: z.string().min(1).max(CONNECTOR_PROMPT_LIMITS.maxOpaqueIdLength),
  itemId: z.string().min(1).max(CONNECTOR_PROMPT_LIMITS.maxOpaqueIdLength)
})

export type MobileSessionItemTarget = z.output<typeof Target>
export type MobileSessionItemOutcome = 'landed' | 'missing' | 'aborted'
export type MobileSessionItemNavigation = {
  target: MobileSessionItemTarget
  pendingPrompt?: boolean
  complete: (outcome: MobileSessionItemOutcome) => void
}
export type MobileSessionItemPresentation = { itemNavigation?: MobileSessionItemNavigation | null }
export type MobileSessionItemLink = {
  selection: MobileSessionItemTarget | null
  navigation: MobileSessionItemNavigation | null
  /** An access request the route asks to review, until `reviewed`. */
  access: { requestId: string; reviewed: () => void } | null
}

export function parseMobileSessionItemTarget(
  value: string | undefined
): MobileSessionItemTarget | null {
  try {
    const parsed = Target.safeParse(JSON.parse(value ?? 'null'))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// The route's one-shot request param also carries an access request to review, from its push.
const AccessTarget = z.object({
  accessRequestId: z.string().min(1).max(CONNECTOR_PROMPT_LIMITS.maxOpaqueIdLength)
})

export function mobileSessionAccessTarget(accessRequestId: string): string {
  return JSON.stringify({ accessRequestId })
}

/** The access request a route asks to review; null for anything else. */
export function parseMobileSessionAccessTarget(value: string | undefined): string | null {
  try {
    const parsed = AccessTarget.safeParse(JSON.parse(value ?? 'null'))
    return parsed.success ? parsed.data.accessRequestId : null
  } catch {
    return null
  }
}
