// Send closed error_class enums only, never raw messages/stacks; add new buckets when unknown volume warrants call-site review.

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
