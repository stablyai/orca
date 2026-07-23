import { describe, expect, it } from 'vitest'
import {
  FILESYSTEM_WATCHER_MAX_CLAIMS,
  FILESYSTEM_WATCHER_MAX_CLAIMS_PER_SENDER,
  FILESYSTEM_WATCHER_MAX_PATH_BYTES,
  FilesystemWatcherAdmission,
  parseFilesystemWatcherIdentity
} from './filesystem-watcher-admission'

describe('filesystem watcher admission', () => {
  it('caps unique claims per sender and recovers after release', () => {
    const admission = new FilesystemWatcherAdmission()
    const releases = Array.from({ length: FILESYSTEM_WATCHER_MAX_CLAIMS_PER_SENDER }, (_, index) =>
      admission.claim(1, `local:/repo-${index}`, 1)
    )

    expect(() => admission.claim(1, 'local:/overflow', 1)).toThrow('capacity reached')
    expect(admission.evidence().claimCount).toBe(FILESYSTEM_WATCHER_MAX_CLAIMS_PER_SENDER)

    releases[0]?.release()
    expect(() => admission.claim(1, 'local:/recovered', 1)).not.toThrow()
  })

  it('caps aggregate claims across senders without double-counting duplicate watches', () => {
    const admission = new FilesystemWatcherAdmission()
    for (let index = 0; index < FILESYSTEM_WATCHER_MAX_CLAIMS; index += 1) {
      admission.claim(index, `local:/repo-${index}`, 1)
    }

    expect(admission.claim(0, 'local:/repo-0', 1).added).toBe(false)
    expect(() => admission.claim(FILESYSTEM_WATCHER_MAX_CLAIMS, 'local:/overflow', 1)).toThrow(
      'capacity reached'
    )

    admission.releaseSender(0)
    expect(() =>
      admission.claim(FILESYSTEM_WATCHER_MAX_CLAIMS, 'local:/recovered', 1)
    ).not.toThrow()
  })

  it('bounds retained path bytes before creating a watcher key', () => {
    const exact = 'é'.repeat(FILESYSTEM_WATCHER_MAX_PATH_BYTES / 2)

    expect(parseFilesystemWatcherIdentity({ worktreePath: exact }).retainedBytes).toBe(
      FILESYSTEM_WATCHER_MAX_PATH_BYTES
    )
    expect(() => parseFilesystemWatcherIdentity({ worktreePath: `${exact}x` })).toThrow(
      `exceeds ${FILESYSTEM_WATCHER_MAX_PATH_BYTES} UTF-8 bytes`
    )
  })

  it('does not let a stale release remove a replacement claim', () => {
    const admission = new FilesystemWatcherAdmission()
    const old = admission.claim(1, 'local:/repo', 1)
    admission.clear()
    admission.claim(1, 'local:/repo', 1)

    old.release()

    expect(admission.evidence().claimCount).toBe(1)
  })
})
