export type HostTerminalShare = {
  /** Live plus starting terminals of every kind. */
  terminals: number
  automaticInFlight: number
  automaticLive: number
  automaticAdmits: readonly number[]
}

export type HostTerminalLedgerEntry = HostTerminalShare & {
  schemaVersion: 1
  pid: number
  updatedAt: number
}

// Bound admission history so malformed entries cannot impose unbounded sorting work.
const MAX_ADMITS = 64

function count(value: unknown): number {
  return Number.isSafeInteger(value) ? Math.max(0, Number(value)) : 0
}

/** Older daemons publish only terminal counts, so automatic-work fields remain optional. */
export function parseHostTerminalLedgerEntry(raw: string): HostTerminalLedgerEntry | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('pid' in value) ||
    !Number.isSafeInteger(value.pid) ||
    !('terminals' in value) ||
    !Number.isSafeInteger(value.terminals) ||
    !('updatedAt' in value) ||
    typeof value.updatedAt !== 'number'
  ) {
    return null
  }
  const admits =
    'automaticAdmits' in value && Array.isArray(value.automaticAdmits)
      ? value.automaticAdmits
          .filter((at): at is number => typeof at === 'number' && Number.isFinite(at))
          .slice(-MAX_ADMITS)
      : []
  return {
    schemaVersion: 1,
    pid: Number(value.pid),
    updatedAt: value.updatedAt,
    terminals: count(value.terminals),
    automaticInFlight: 'automaticInFlight' in value ? count(value.automaticInFlight) : 0,
    automaticLive: 'automaticLive' in value ? count(value.automaticLive) : 0,
    automaticAdmits: admits
  }
}

export function sameHostTerminalShare(a: HostTerminalShare, b: HostTerminalShare): boolean {
  return (
    a.terminals === b.terminals &&
    a.automaticInFlight === b.automaticInFlight &&
    a.automaticLive === b.automaticLive &&
    a.automaticAdmits.length === b.automaticAdmits.length &&
    a.automaticAdmits.every((at, index) => at === b.automaticAdmits[index])
  )
}
