// Best-effort classifier from a thrown value to the closed `error_class`
// enum on `agent_error`. The wire never carries a raw error message or stack
// — every transmitted error is bucketed into one of the two enum members
// (`binary_not_found` for ENOENT-shaped failures, `unknown` for everything
// else). A non-zero `unknown` slice on the dashboard is the trigger to add a
// new enum value alongside the call site that would emit it.

import type { ErrorClass } from '../../shared/telemetry-events'

export type ClassifiedError = {
  error_class: ErrorClass
}

export function classifyError(err: unknown): ClassifiedError {
  if (err === null || err === undefined) {
    return { error_class: 'unknown' }
  }

  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined
  const syscall =
    typeof err === 'object' && err !== null && 'syscall' in err
      ? (err as { syscall?: unknown }).syscall
      : undefined
  const message =
    typeof err === 'object' && err !== null && 'message' in err
      ? (err as { message?: unknown }).message
      : undefined

  if (
    code === 'ENOENT' &&
    (typeof syscall !== 'string' || syscall.toLowerCase().startsWith('spawn'))
  ) {
    return { error_class: 'binary_not_found' }
  }

  if (typeof message === 'string' && /\bspawn\b/i.test(message) && /\benoent\b/i.test(message)) {
    return { error_class: 'binary_not_found' }
  }

  return { error_class: 'unknown' }
}
