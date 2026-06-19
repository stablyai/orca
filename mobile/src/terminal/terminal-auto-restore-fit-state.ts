export type TerminalAutoRestoreFitByHost = Record<string, number | null | undefined>

export function normalizeTerminalAutoRestoreFitMs(value: number | null | undefined): number | null {
  return value === undefined ? null : value
}

export function setTerminalAutoRestoreFitMsForHost(
  current: TerminalAutoRestoreFitByHost,
  hostId: string,
  value: number | null | undefined
): TerminalAutoRestoreFitByHost {
  const nextValue = normalizeTerminalAutoRestoreFitMs(value)
  if (current[hostId] === nextValue) {
    return current
  }
  return { ...current, [hostId]: nextValue }
}
