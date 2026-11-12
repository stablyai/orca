import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const artifacts = vi.hoisted(() => ({ files: ['orcad-server.js', 'daemon-entry.js'] }))
vi.mock('../artifact-slots/orcad-artifact-identity', () => ({
  listOrcadArtifactFilenames: async () => artifacts.files
}))

import {
  consumeOrcadStartupQualification,
  recordOrcadStartupQualification
} from './orcad-startup-qualification'

let slot: string

beforeEach(() => {
  slot = mkdtempSync(join(tmpdir(), 'orcad-qualified-'))
  for (const name of artifacts.files) {
    writeFileSync(join(slot, name), `${name} bytes`)
  }
})

afterEach(() => {
  rmSync(slot, { recursive: true, force: true })
})

describe('orcad startup qualification', () => {
  it('consumes a matching marker once, so a launch that dies before readiness re-qualifies', async () => {
    await recordOrcadStartupQualification(slot, 'key-1')

    expect(await consumeOrcadStartupQualification(slot, 'key-1')).toBe(true)
    expect(await consumeOrcadStartupQualification(slot, 'key-1')).toBe(false)
  })
})
