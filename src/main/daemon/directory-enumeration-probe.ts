import type { Dir } from 'node:fs'
import { opendir } from 'node:fs/promises'

/** `denied` is the only outcome that proves a permission refusal; `other` keeps unknown errors apart. */
export type DirectoryEnumerationOutcome = 'ok' | 'denied' | 'missing' | 'other'

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  const { code } = error
  return typeof code === 'string' ? code : undefined
}

function outcomeForError(error: unknown): DirectoryEnumerationOutcome {
  const code = errorCode(error)
  if (code === 'EPERM' || code === 'EACCES') {
    return 'denied'
  }
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'other'
}

/** Probe enumeration because TCC can reject opendir even when access() succeeds. */
export async function enumerateDirectoryOnce(path: string): Promise<DirectoryEnumerationOutcome> {
  let dir: Dir | undefined
  try {
    dir = await opendir(path)
    await dir.read()
    return 'ok'
  } catch (error) {
    return outcomeForError(error)
  } finally {
    await dir?.close().catch(() => {
      // A handle we cannot close says nothing about readability.
    })
  }
}
