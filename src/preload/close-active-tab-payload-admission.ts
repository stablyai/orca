import type { CloseActiveTabPayload } from './api/ui-command-event-api'

export type AdmittedCloseActiveTabPayload =
  | { kind: 'legacy' }
  | { kind: 'source'; payload: CloseActiveTabPayload }
  | { kind: 'invalid' }

export function admitCloseActiveTabPayload(value: unknown): AdmittedCloseActiveTabPayload {
  if (value === undefined) {
    return { kind: 'legacy' }
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).sourceId === 'string' &&
    (value as Record<string, unknown>).sourceId !== ''
  ) {
    return {
      kind: 'source',
      payload: { sourceId: (value as Record<string, unknown>).sourceId as string }
    }
  }
  return { kind: 'invalid' }
}
