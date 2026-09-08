export function mobileLogErrorKind(error: unknown): string {
  return error instanceof Error ? 'error' : typeof error
}
