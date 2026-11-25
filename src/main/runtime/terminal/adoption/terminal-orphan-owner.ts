export type TerminalOrphanExecutionOwner = {
  connectionId: string | null
  wslDistro?: string | null
}

function normalizeWslDistro(distro: string | null): string | null {
  const normalized = distro?.trim().toLowerCase() ?? ''
  return normalized || null
}

export function terminalOrphanExecutionOwnersEqual(
  expected: TerminalOrphanExecutionOwner,
  actual: TerminalOrphanExecutionOwner
): boolean {
  if (expected.connectionId !== actual.connectionId) {
    return false
  }
  if (expected.connectionId !== null) {
    return true
  }
  if (expected.wslDistro === undefined || actual.wslDistro === undefined) {
    return false
  }
  return normalizeWslDistro(expected.wslDistro) === normalizeWslDistro(actual.wslDistro)
}
