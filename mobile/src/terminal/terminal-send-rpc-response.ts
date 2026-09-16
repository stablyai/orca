function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Whether an admitted terminal-send payload reports the write as accepted. */
export function isTerminalSendResultAccepted(result: unknown): boolean {
  return isRecord(result) && isRecord(result.send) && result.send.accepted === true
}
