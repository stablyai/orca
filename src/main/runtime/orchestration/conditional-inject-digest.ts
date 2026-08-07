import { createHash } from 'node:crypto'

export const CONDITIONAL_INJECT_SCHEMA = 'orca.conditional-dispatch-inject.v1' as const

export type ConditionalInjectDigestInput = {
  schema: typeof CONDITIONAL_INJECT_SCHEMA
  attemptId: string
  taskId: string
  dagNodeId: string
  payload: string
  coordinator: { handle: string; pane: string }
  worker: { handle: string; pane: string; worktreeId: string }
  runtimeId: string
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key])
    }
    return sorted
  }
  return value
}

export function canonicalConditionalInjectRequest(input: ConditionalInjectDigestInput): string {
  return JSON.stringify(canonicalize(input))
}

export function digestConditionalInjectRequest(input: ConditionalInjectDigestInput): string {
  return createHash('sha256').update(canonicalConditionalInjectRequest(input), 'utf8').digest('hex')
}
