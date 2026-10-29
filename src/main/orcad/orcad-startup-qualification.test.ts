import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-managed-launch-env'

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

  it('names the runtime, node version, libc and kernel in the key', async () => {
    const key = JSON.parse(await orcadStartupQualificationKey(slot, '0.1.0+aaaaaaaaaaaa'))

    expect(Object.keys(key)).toEqual(
      expect.arrayContaining(['runtime', 'node', 'abi', 'kernel', 'files'])
    )
    expect(key.abi).toHaveProperty('glibcVersion')
  })

  it.each(['NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'TMPDIR'])(
    're-qualifies when the launch environment changes %s',
    async (name) => {
      const env = { NODE_OPTIONS: '', LD_PRELOAD: '', LD_LIBRARY_PATH: '', TMPDIR: '/tmp' }
      const key = await orcadStartupQualificationKey(slot, '0.1.0+aaaaaaaaaaaa', env)

      expect(await orcadStartupQualificationKey(slot, '0.1.0+aaaaaaaaaaaa', { ...env })).toBe(key)
      expect(
        await orcadStartupQualificationKey(slot, '0.1.0+aaaaaaaaaaaa', {
          ...env,
          [name]: 'changed'
        })
      ).not.toBe(key)
      expect(
        await orcadStartupQualificationKey(slot, '0.1.0+aaaaaaaaaaaa', {
          ...env,
          [name]: undefined
        })
      ).not.toBe(key)
    }
  )

  it('fails the key closed when an installed file is missing', async () => {
    rmSync(join(slot, 'daemon-entry.js'))

    await expect(orcadStartupQualificationKey(slot, '0.1.0+aaaaaaaaaaaa')).rejects.toThrow()
  })

  it('consumes a matching marker once, so a launch that dies before readiness re-qualifies', async () => {
    await recordOrcadStartupQualification(slot, 'key-1')

    expect(await consumeOrcadStartupQualification(slot, 'key-1')).toBe(true)
    expect(await consumeOrcadStartupQualification(slot, 'key-1')).toBe(false)
  })

  it('keeps qualifying on a different key, a missing marker or a torn one', async () => {
    expect(await consumeOrcadStartupQualification(slot, 'key-1')).toBe(false)
    await recordOrcadStartupQualification(slot, 'key-2')
    expect(await consumeOrcadStartupQualification(slot, 'key-1')).toBe(false)
    writeFileSync(join(slot, ORCAD_STARTUP_QUALIFIED_FILENAME), 'key-')
    expect(await consumeOrcadStartupQualification(slot, 'key-1')).toBe(false)
  })

  it('writes the marker whole through a temp file and leaves no temp behind', async () => {
    await recordOrcadStartupQualification(slot, 'key-1')

    expect(readFileSync(join(slot, ORCAD_STARTUP_QUALIFIED_FILENAME), 'utf8')).toBe('key-1')
    expect(readdirSync(slot).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('voids a marker on demand, and is silent when there is none', async () => {
    await recordOrcadStartupQualification(slot, 'key-1')

    await discardOrcadStartupQualification(slot)
    await discardOrcadStartupQualification(slot)

    expect(await consumeOrcadStartupQualification(slot, 'key-1')).toBe(false)
  })

  it('qualifies only managed slots outside the app resources', () => {
    const managed = { [ORCAD_MANAGED_ACTIVATION_ROOT_ENV]: '/home/u/.orca-remote' }
    const resources = join(slot, 'Orca.app', 'Contents', 'Resources')

    expect(isQualifiableOrcadSlot(join(slot, 'orcad-0.1.0+a'), managed, resources)).toBe(true)
    expect(isQualifiableOrcadSlot(join(slot, 'orcad-0.1.0+a'), managed, undefined)).toBe(true)
    expect(isQualifiableOrcadSlot(join(slot, 'orcad-0.1.0+a'), {}, undefined)).toBe(false)
    expect(isQualifiableOrcadSlot(join(resources, 'orcad'), managed, resources)).toBe(false)
    expect(isQualifiableOrcadSlot(resources, managed, resources)).toBe(false)
  })

  it('fails open when the slot cannot be written', async () => {
    await expect(
      recordOrcadStartupQualification(join(slot, 'missing-dir'), 'key-1')
    ).resolves.toBeUndefined()
  })
})
