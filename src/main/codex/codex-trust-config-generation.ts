import {
  removeFileAtomicallyIfUnchanged,
  writeFileAtomicallyIfUnchanged
} from '../codex-accounts/fs-utils'
import {
  captureCodexTrustConfig,
  type CodexTrustConfigSnapshot
} from './codex-trust-config-rollback'

export function codexTrustConfigSnapshotsEqual(
  left: CodexTrustConfigSnapshot,
  right: CodexTrustConfigSnapshot
): boolean {
  return (
    (left.restorePath ?? '') === (right.restorePath ?? '') &&
    left.existed === right.existed &&
    (!left.existed || (right.existed && left.contents.equals(right.contents)))
  )
}

export function restoreCodexTrustConfigIfUnchanged(
  tomlPath: string,
  snapshot: CodexTrustConfigSnapshot,
  expectedCurrent: CodexTrustConfigSnapshot
): boolean {
  const restorePath = snapshot.restorePath ?? tomlPath
  const expectedPath = expectedCurrent.restorePath ?? tomlPath
  if (restorePath !== expectedPath) {
    return false
  }
  if (!snapshot.existed) {
    return expectedCurrent.existed
      ? removeFileAtomicallyIfUnchanged(expectedPath, expectedCurrent.contents)
      : true
  }
  return writeFileAtomicallyIfUnchanged(
    expectedPath,
    expectedCurrent.existed ? expectedCurrent.contents : null,
    snapshot.contents,
    { mode: snapshot.mode }
  )
}

export function restoreCodexTrustFilesIfUnchanged(
  files: readonly {
    path: string
    snapshot: CodexTrustConfigSnapshot
    expectedCurrent: CodexTrustConfigSnapshot
  }[]
): boolean {
  if (
    files.some(
      ({ path, expectedCurrent }) =>
        !codexTrustConfigSnapshotsEqual(captureCodexTrustConfig(path), expectedCurrent)
    )
  ) {
    return false
  }
  return files.every(({ path, snapshot, expectedCurrent }) =>
    restoreCodexTrustConfigIfUnchanged(path, snapshot, expectedCurrent)
  )
}
