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
    // Why: codex can atomically replace auth.json while the poll runs; a later
    // poll will observe the stable credential. An unreadable initial file must
    // disable the shortcut rather than look like a fresh login.
    return undefined
  }
}

/** Whether a login has written credentials of its own since the snapshot was taken. */
export function loginAuthChanged(
  initial: string | null | undefined,
  current: string | null | undefined
): boolean {
  // Why: metadata-only touches can happen before OAuth finishes. Requiring new
  // credential bytes prevents reauthentication from being killed prematurely.
  return initial !== undefined && current !== undefined && current !== null && current !== initial
}
