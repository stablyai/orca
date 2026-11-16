// Main installs its Chromium kill guard here; daemon, relay, and CLI cannot import main code.

/** Windows tree walks can target reused PIDs; POSIX groups contain only Orca-assigned processes. */
export type ProcessTreeKillScope = 'win-taskkill-tree' | 'posix-process-group'

export type ProcessTreeKill = {
  pid: number
  site: string
  scope: ProcessTreeKillScope
}

/** Refusal forbids the PID-based tree walk; callers must still kill the root through its handle. */
type ProcessTreeKillGate = (kill: ProcessTreeKill) => boolean

let gate: ProcessTreeKillGate | null = null

export function setProcessTreeKillGate(next: ProcessTreeKillGate | null): void {
  gate = next
}

export function admitProcessTreeKill(kill: ProcessTreeKill): boolean {
  try {
    return gate?.(kill) ?? true
  } catch {
    // Diagnostics must never turn a successful termination into a failed one.
    return true
  }
}
