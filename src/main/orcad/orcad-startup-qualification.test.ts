import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const artifacts = vi.hoisted(() => ({ files: ['orcad-server.js', 'daemon-entry.js'] }))
vi.mock('./orcad-artifact-identity', () => ({
  listOrcadArtifactFilenames: async () => artifacts.files
}))

import {
  consumeOrcadStartupQualification,
  discardOrcadStartupQualification,
  isQualifiableOrcadSlot,
  ORCAD_STARTUP_QUALIFIED_FILENAME,
  orcadStartupQualificationKey,
  recordOrcadStartupQualification
} from './orcad-startup-qualification'
import {
  ORCAD_MANAGED_ACTIVATION_ROOT_ENV,
  ORCAD_STARTUP_QUALIFICATION_DIR_ENV
} from '../../shared/orcad-managed-launch-env'

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

  it('qualifies a read-only slot only when its launcher names an absolute marker directory', () => {
    expect(isQualifiableOrcadSlot(slot, {}, undefined)).toBe(false)
    expect(
      isQualifiableOrcadSlot(slot, { [ORCAD_MANAGED_ACTIVATION_ROOT_ENV]: '/m' }, undefined)
    ).toBe(true)
    expect(
      isQualifiableOrcadSlot(slot, { [ORCAD_STARTUP_QUALIFICATION_DIR_ENV]: '/opt/q' }, undefined)
    ).toBe(true)
    expect(
      isQualifiableOrcadSlot(slot, { [ORCAD_STARTUP_QUALIFICATION_DIR_ENV]: 'relative' }, undefined)
    ).toBe(false)
    // App bundles stay unwritten even when the variable leaks into their environment.
    expect(
      isQualifiableOrcadSlot(
        join(slot, 'resources', 'orcad'),
        { [ORCAD_STARTUP_QUALIFICATION_DIR_ENV]: '/opt/q' },
        join(slot, 'resources')
      )
    ).toBe(false)
  })

  it('keeps the marker in the named directory, leaving the slot untouched', async () => {
    const markersRoot = mkdtempSync(join(tmpdir(), 'orcad-qualified-markers-'))
    // The launcher may name a directory that does not exist yet.
    const markers = join(markersRoot, 'slot')
    const env = { [ORCAD_STARTUP_QUALIFICATION_DIR_ENV]: markers }
    try {
      await recordOrcadStartupQualification(slot, 'key-1', env)

      expect(existsSync(join(markers, ORCAD_STARTUP_QUALIFIED_FILENAME))).toBe(true)
      expect(existsSync(join(slot, ORCAD_STARTUP_QUALIFIED_FILENAME))).toBe(false)
      expect(await consumeOrcadStartupQualification(slot, 'key-1', {})).toBe(false)
      expect(await consumeOrcadStartupQualification(slot, 'key-1', env)).toBe(true)

      await recordOrcadStartupQualification(slot, 'key-2', env)
      await discardOrcadStartupQualification(slot, env)
      expect(await consumeOrcadStartupQualification(slot, 'key-2', env)).toBe(false)
    } finally {
      rmSync(markersRoot, { recursive: true, force: true })
    }
  })
})
