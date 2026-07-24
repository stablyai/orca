import { describe, expect, it } from 'vitest'
import {
  RUNTIME_FILE_WATCHER_MAX_LEASES,
  RUNTIME_FILE_WATCHER_MAX_PATH_BYTES,
  RuntimeFileWatcherAdmission
} from './runtime-file-watcher-admission'

describe('runtime file watcher admission', () => {
  it('caps pending and active leases, then recovers after release', () => {
    const admission = new RuntimeFileWatcherAdmission()
    const releases = Array.from({ length: RUNTIME_FILE_WATCHER_MAX_LEASES }, (_, index) =>
      admission.claim('runtime-a', index % 2 === 0 ? 'ssh-a' : undefined, `/repo-${index}`)
    )

    expect(admission.evidence().leases).toBe(RUNTIME_FILE_WATCHER_MAX_LEASES)
    expect(() => admission.claim('runtime-a', undefined, '/overflow')).toThrow('capacity reached')

    releases[0]?.()
    releases[0]?.()
    expect(() => admission.claim('runtime-a', undefined, '/recovered')).not.toThrow()
  })

  it('bounds multibyte roots before retaining a lease', () => {
    const admission = new RuntimeFileWatcherAdmission()
    const exact = 'é'.repeat(RUNTIME_FILE_WATCHER_MAX_PATH_BYTES / 2)

    expect(() => admission.claim('runtime-a', 'ssh-a', exact)).not.toThrow()
    expect(() => admission.claim('runtime-a', 'ssh-a', `${exact}x`)).toThrow(
      `exceeds ${RUNTIME_FILE_WATCHER_MAX_PATH_BYTES} UTF-8 bytes`
    )
    expect(admission.evidence().leases).toBe(1)
  })
})
