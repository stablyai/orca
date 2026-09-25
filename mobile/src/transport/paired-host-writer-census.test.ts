/**
 * Who may write a whole host profile: pairing, which creates or re-pairs it.
 *
 * A relay learner (supervisor, credential rotation, direct upgrade) holds a snapshot taken when its
 * connection opened, so a full-profile save from it reverts any Edit Host made since. Those write
 * through `setRelayRouting`, which takes no profile.
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { censusSourceFiles } from '../test-support/census-source-files'

const MOBILE_DIR = fileURLToPath(new URL('../../', import.meta.url))

const PAIRING_WRITERS = [
  'src/transport/host-store.ts',
  'src/transport/host-store.web.ts',
  'src/transport/mobile-relay-pairing-recovery.ts',
  'src/transport/pre-profile-pairing-coordinator.ts'
]

function referencingFiles(): string[] {
  return ['src', 'app']
    .flatMap((directory) => censusSourceFiles(join(MOBILE_DIR, directory)))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => /\bsavePairedHost\b/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(MOBILE_DIR, file))
    .sort()
}

describe('full host profile writes', () => {
  it('are reachable only from pairing', () => {
    // Also the presence precondition: the store itself must match, or the matcher is broken.
    expect(referencingFiles()).toEqual(PAIRING_WRITERS)
  })
})
