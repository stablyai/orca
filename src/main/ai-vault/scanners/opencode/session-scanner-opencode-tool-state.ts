import { asRecord } from '../../parsing/session-record-fields'

// Normalize OpenCode filePath to the shared file_path spelling before formatting tool input.
export function openCodeToolInput(input: unknown): unknown {
  const record = asRecord(input)
  if (!record || typeof record.filePath !== 'string' || typeof record.file_path === 'string') {
    return input
  }
  return { ...record, file_path: record.filePath }
}

// Prefer failure text over output; running calls can still be indexed by their command alone.
export function openCodeToolOutcome(state: Record<string, unknown> | null): string | null {
  const error = state?.error
  if (typeof error === 'string' && error.trim()) {
    return error
  }
  const output = state?.output
  return typeof output === 'string' && output.trim() ? output : null
}
