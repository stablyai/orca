/**
 * Install Petdex pets into Orca's on-disk custom pet store
 * (`userData/sidekicks/custom/<uuid>/`) and return CustomPet index rows.
 *
 * Pure enough to unit-test with injected fetch/fs; the ops CLI and IPC both
 * call through here so seed never drifts from in-app import semantics.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CustomPet } from '../../shared/types'
import {
  isPetdexAllowedUrl,
  PETDEX_MANIFEST_URL,
  selectStarterEntries,
  type PetdexManifest,
  type PetdexManifestEntry
} from '../../shared/petdex-catalog'
import {
  buildBundlePetJson,
  buildCustomPetRecord,
  PetdexConvertError
} from '../../shared/petdex-to-orca'
import { readWebpDimensionsFromBuffer } from '../ipc/pet-bundle'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export type PetdexInstallResult = {
  installed: CustomPet[]
  skipped: { slug: string; reason: string }[]
  manifestTotal: number
}

const DEFAULT_UA = 'orca-petdex-seed/1.0 (+meshina; https://github.com/maczzinatui/orca)'

export async function fetchPetdexManifest(
  fetchImpl: FetchFn = fetch,
  url: string = PETDEX_MANIFEST_URL
): Promise<PetdexManifest> {
  if (!isPetdexAllowedUrl(url) && !url.startsWith('file:')) {
    // file: allowed only in tests; production always uses PETDEX_MANIFEST_URL
    if (!url.startsWith('file:')) {
      throw new PetdexConvertError(`refusing non-petdex manifest URL: ${url}`)
    }
  }
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json' },
    redirect: 'follow'
  })
  if (!res.ok) {
    throw new PetdexConvertError(`manifest HTTP ${res.status}`)
  }
  const data = (await res.json()) as PetdexManifest
  if (!data || !Array.isArray(data.pets)) {
    throw new PetdexConvertError('manifest missing pets array')
  }
  return data
}

export async function downloadPetdexSheet(
  entry: PetdexManifestEntry,
  fetchImpl: FetchFn = fetch
): Promise<Buffer> {
  if (!isPetdexAllowedUrl(entry.spritesheetUrl)) {
    throw new PetdexConvertError(`refusing non-petdex sheet host for ${entry.slug}`)
  }
  const res = await fetchImpl(entry.spritesheetUrl, {
    headers: { 'User-Agent': DEFAULT_UA },
    redirect: 'follow'
  })
  if (!res.ok) {
    throw new PetdexConvertError(`sheet HTTP ${res.status} for ${entry.slug}`)
  }
  const ab = await res.arrayBuffer()
  if (ab.byteLength < 100 || ab.byteLength > 64 * 1024 * 1024) {
    throw new PetdexConvertError(`sheet size out of bounds for ${entry.slug}: ${ab.byteLength}`)
  }
  return Buffer.from(ab)
}

/**
 * Write one pet bundle under `customPetsDir/<uuid>/` and return the index row.
 * Atomic tmpdir + rename so a failed download never leaves a half-bundle.
 */
export async function installPetdexEntry(
  entry: PetdexManifestEntry,
  customPetsDir: string,
  fetchImpl: FetchFn = fetch
): Promise<CustomPet> {
  const sheetBuf = await downloadPetdexSheet(entry, fetchImpl)
  const dims = readWebpDimensionsFromBuffer(sheetBuf)
  if (!dims) {
    throw new PetdexConvertError(`could not decode webp dimensions for ${entry.slug}`)
  }

  const id = randomUUID()
  const destDir = join(customPetsDir, id)
  const tmpDir = `${destDir}.tmp`
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  await mkdir(tmpDir, { recursive: true })

  const petJson = buildBundlePetJson({
    slug: entry.slug,
    displayName: entry.displayName,
    description: entry.kind
      ? `Petdex ${entry.kind}${entry.submittedBy ? ` by ${entry.submittedBy}` : ''}`
      : undefined
  })
  // Provenance stamp for operators (not read by Orca runtime).
  const provenance = {
    source: 'petdex',
    slug: entry.slug,
    spritesheetUrl: entry.spritesheetUrl,
    petJsonUrl: entry.petJsonUrl,
    sheetSha256: createHash('sha256').update(sheetBuf).digest('hex'),
    installedAt: new Date().toISOString()
  }

  try {
    await writeFile(join(tmpDir, 'spritesheet.webp'), sheetBuf)
    await writeFile(join(tmpDir, 'pet.json'), JSON.stringify(petJson, null, 2) + '\n')
    await writeFile(join(tmpDir, 'petdex-provenance.json'), JSON.stringify(provenance, null, 2) + '\n')
    await mkdir(customPetsDir, { recursive: true })
    await rename(tmpDir, destDir)
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }

  return buildCustomPetRecord({
    id,
    label: entry.displayName,
    dims
  })
}

/** Install the curated starter pack. Continues on per-pet failures. */
export async function installPetdexStarterPack(args: {
  customPetsDir: string
  fetchImpl?: FetchFn
  manifestUrl?: string
  slugs?: readonly string[]
  onProgress?: (msg: string) => void
}): Promise<PetdexInstallResult> {
  const fetchImpl = args.fetchImpl ?? fetch
  const log = args.onProgress ?? (() => {})
  log(`fetching Petdex manifest…`)
  const manifest = await fetchPetdexManifest(fetchImpl, args.manifestUrl ?? PETDEX_MANIFEST_URL)
  const entries = selectStarterEntries(manifest, args.slugs)
  log(`manifest total=${manifest.total ?? manifest.pets.length}; starter hits=${entries.length}`)

  const installed: CustomPet[] = []
  const skipped: { slug: string; reason: string }[] = []

  for (const entry of entries) {
    try {
      log(`installing ${entry.slug} (${entry.displayName})…`)
      const pet = await installPetdexEntry(entry, args.customPetsDir, fetchImpl)
      installed.push(pet)
      log(`  → ${pet.id} ok`)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      skipped.push({ slug: entry.slug, reason })
      log(`  → SKIP ${entry.slug}: ${reason}`)
    }
  }

  return {
    installed,
    skipped,
    manifestTotal: manifest.total ?? manifest.pets.length
  }
}
