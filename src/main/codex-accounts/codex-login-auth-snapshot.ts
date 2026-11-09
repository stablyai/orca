import { readFileSync } from 'node:fs'

/** The bytes of a managed home's auth.json, null when absent, undefined when unreadable. */
export function readLoginAuthSnapshot(authJsonPath: string): string | null | undefined {
  try {
    return readFileSync(authJsonPath, 'utf-8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null
    }
    // Unreadable snapshots cannot prove that a later credential belongs to this login.
    return undefined
  }
}

export function loginAuthChanged(
  initial: string | null | undefined,
  current: string | null | undefined
): boolean {
  // Compare credential bytes so metadata-only touches cannot prematurely end reauthentication.
  return initial !== undefined && current !== undefined && current !== null && current !== initial
}
