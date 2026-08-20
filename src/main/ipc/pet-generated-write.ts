import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { CustomPet } from '../../shared/pet-types'
import { applyCodexPetDefaults } from './pet-bundle'
import { PetManifestSchema } from './pet-bundle-manifest-schema'
import { buildBundleSprite } from './pet-bundle-sprite-metadata'
import { MAX_BYTES } from './pet-import-size-limits'
import { getPetsDir } from './pet-storage-paths'

/** Fixed by main, never by the caller — see `writeGeneratedPet`. */
const SHEET_FILE_NAME = 'spritesheet.webp'
const SHEET_MIME = 'image/webp'
const MAX_LABEL_LENGTH = 40

export type GeneratedPetRequest = {
  sheet: ArrayBuffer | Uint8Array
  manifest: unknown
  label?: string
}

function toBuffer(sheet: ArrayBuffer | Uint8Array): Buffer {
  return sheet instanceof Uint8Array ? Buffer.from(sheet) : Buffer.from(new Uint8Array(sheet))
}

/** Persists a pet the app generated, as a bundle indistinguishable from an
 *  imported one.
 *
 *  The renderer supplies bytes rather than a path it picked, so the two things
 *  it must not control are pinned here: where the sheet lands, and what the
 *  manifest says it is called. Everything else goes through the same zod schema
 *  and the same geometry checks an external `.codex-pet` faces, because a
 *  generated pet that skipped them would be the one shape of bundle nobody had
 *  validated. */
export async function writeGeneratedPet(request: GeneratedPetRequest): Promise<CustomPet> {
  const bytes = toBuffer(request.sheet)
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error('Generated spritesheet exceeded the size limit.')
  }

  // Why: main owns the filename, so the caller's is replaced BEFORE validation
  // rather than after. Sanitising a path we were never going to use would only
  // give the caller a way to fail the parse with one we then discard anyway.
  const candidate =
    typeof request.manifest === 'object' && request.manifest !== null
      ? { ...request.manifest, spritesheetPath: SHEET_FILE_NAME }
      : request.manifest
  const parsed = PetManifestSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new Error('Generated manifest is not a valid pet manifest.')
  }
  const manifest = applyCodexPetDefaults(parsed.data)

  const id = randomUUID()
  const root = getPetsDir()
  await mkdir(root, { recursive: true })
  const destDir = join(root, id)
  const tmpDir = `${destDir}.tmp`

  try {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    await mkdir(tmpDir, { recursive: true })
    const sheetPath = join(tmpDir, SHEET_FILE_NAME)
    await writeFile(sheetPath, bytes)
    await writeFile(join(tmpDir, 'pet.json'), JSON.stringify(manifest, null, 2))
    // Why: validate the written sheet against its own manifest before the
    // rename, so a mismatch never becomes a saved pet the renderer will choke on.
    const sprite = await buildBundleSprite(manifest, sheetPath)
    await rename(tmpDir, destDir)

    const rawLabel = (request.label ?? '').trim()
    return {
      id,
      label: rawLabel.length > 0 ? rawLabel.slice(0, MAX_LABEL_LENGTH) : 'Generated pet',
      fileName: SHEET_FILE_NAME,
      mimeType: SHEET_MIME,
      kind: 'bundle',
      sprite,
      ...(manifest.fps !== undefined ? { spriteFps: manifest.fps } : {})
    }
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    await rm(destDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
