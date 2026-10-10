import type { OrcaPushPayload } from './push-payload'

export type NativeDismissal = {
  remember(payload: OrcaPushPayload): Promise<void>
  wasDismissed(payload: OrcaPushPayload): Promise<boolean>
}
// Android and web use JavaScript storage; iOS requires the native ledger.
export const nativePushDismissal: NativeDismissal | null = null
