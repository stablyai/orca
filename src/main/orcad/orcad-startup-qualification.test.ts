import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const artifacts = vi.hoisted(() => ({ files: ['orcad-server.js', 'daemon-entry.js'] }))
vi.mock('./orcad-artifact-identity', () => ({
  listOrcadArtifactFilenames: async () => artifacts.files
}))

import {
  consumeOrcadStartupQualification,
  orcadStartupQualificationKey,
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
  it('keys on the artifact version and on every installed file staying the same file', async () => {
    const key = await orcadStartupQualificationKey(slot, '0.1.0+aaaaaaaaaaaa')

    expect(await orcadStartupQualificationKey(slot, '0.1.0+aaaaaaaaaaaa')).toBe(key)
    expect(await orcadStartupQualificationKey(slot, '0.2.0+aaaaaaaaaaaa')).not.toBe(key)
    rmSync(join(slot, 'daemon-entry.js'))
    writeFileSync(join(slot, 'daemon-entry.js'), 'replaced')
    expect(await orcadStartupQualificationKey(slot, '0.1.0+aaaaaaaaaaaa')).not.toBe(key)
  })

  it('consumes a matching marker once, so a launch that dies before readiness re-qualifies', async () => {
    await recordOrcadStartupQualification(slot, 'key-1')

    expect(await consumeOrcadStartupQualification(slot, 'key-1')).toBe(true)
    expect(await consumeOrcadStartupQualification(slot, 'key-1')).toBe(false)
  })
})
