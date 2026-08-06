export function appendCodexResetCleanupWarning(message: string, warning: string): string {
  return warning ? `${message}\n\n${warning}` : message
}
