import type { FileWithMtime } from '../session-scanner-types'

export type SessionFileIdentity = { dev?: number; ino?: number; birthtimeMs?: number }

export function sessionFileIdentity(file: SessionFileIdentity): SessionFileIdentity {
  const identity: SessionFileIdentity = {}
  if (Number.isSafeInteger(file.dev) && file.dev !== 0) {
    identity.dev = file.dev
  }
  if (Number.isSafeInteger(file.ino) && file.ino !== 0) {
    identity.ino = file.ino
  }
  if (
    typeof file.birthtimeMs === 'number' &&
    Number.isFinite(file.birthtimeMs) &&
    file.birthtimeMs > 0
  ) {
    identity.birthtimeMs = file.birthtimeMs
  }
  return identity
}

export function sameSessionFileIdentity(
  saved: SessionFileIdentity,
  observed: SessionFileIdentity
): boolean {
  const current = sessionFileIdentity(observed)
  return (
    (current.dev === undefined || saved.dev === current.dev) &&
    (current.ino === undefined || saved.ino === current.ino) &&
    (current.birthtimeMs === undefined || saved.birthtimeMs === current.birthtimeMs)
  )
}

export function sessionFileVersionMatches(
  saved: SessionFileIdentity & { mtimeMs: number; sizeBytes: number | null },
  file: FileWithMtime
): boolean {
  return (
    saved.mtimeMs === file.mtimeMs &&
    (saved.sizeBytes === null ||
      file.sizeBytes === undefined ||
      saved.sizeBytes === file.sizeBytes) &&
    sameSessionFileIdentity(saved, file)
  )
}
