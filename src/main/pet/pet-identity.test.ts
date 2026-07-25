import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const userDataPath = mkdtempSync(join(tmpdir(), 'orca-pet-identity-'))

vi.mock('../persistence', () => ({
  getCanonicalUserDataPath: () => userDataPath
}))

const { resolveTravellingPetId } = await import('./pet-identity')

function writeCustomPet(uuid: string, manifest: string): void {
  const dir = join(userDataPath, 'sidekicks', 'custom', uuid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pet.json'), manifest)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveTravellingPetId', () => {
  it('maps an imported pet UUID to the slug the phone knows it by', () => {
    // The real shape, taken from node-e: the operator's gandalf is stored under
    // a per-install UUID, while the phone bundles it as 'mini-gandalf-the-grey'.
    const uuid = '4aa6e196-405f-4cd2-b19e-a832f4b0651f'
    writeCustomPet(
      uuid,
      JSON.stringify({
        id: 'mini-gandalf-the-grey',
        displayName: 'Mini Gandalf the Grey',
        spritesheetPath: 'spritesheet.webp'
      })
    )
    expect(resolveTravellingPetId(uuid)).toBe('mini-gandalf-the-grey')
  })

  it('leaves a bundled desktop pet id alone', () => {
    // These have no custom directory and are already stable names.
    expect(resolveTravellingPetId('claude-the-mage')).toBe('claude-the-mage')
  })

  it('falls back to the raw id when the manifest is missing', () => {
    expect(resolveTravellingPetId('unknown-uuid')).toBe('unknown-uuid')
  })

  it('falls back to the raw id when the manifest is corrupt', () => {
    writeCustomPet('broken', '{ not json')
    expect(resolveTravellingPetId('broken')).toBe('broken')
  })

  it('falls back when the manifest declares no usable id', () => {
    writeCustomPet('blank', JSON.stringify({ id: '   ' }))
    expect(resolveTravellingPetId('blank')).toBe('blank')
  })
})
