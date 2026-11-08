// Copy the selected N-API/libc/arch slot into build/Release to avoid node-pty’s libc-blind fallback.
// Build slots from patched sources: symbol pins and linker flags preserve the glibc floor.
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { usesNodePtySpawnHelper } from '../../shared/node-pty-spawn-helper'
import { COMPAT_SERVER_TARGET_BASES, COMPAT_SERVER_TARGETS } from '../../shared/node-runtime-pin'
import {
  compareDottedVersions,
  hostNodeApiVersion,
  nativeSlotName,
  type NativeHostAbi
} from './native-host-abi'

const SHA256 = /^[0-9a-f]{64}$/
// Slot-relative POSIX paths prevent manifest traversal outside build/Release.
const SLOT_FILE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[\w.-]+(?:\/[\w.-]+)*$/

const PrebuiltSlotEntrySchema = z.object({
  platform: z.string(),
  arch: z.string(),
  libc: z.enum(['glibc', 'musl', 'none']),
  /** Highest required strong GLIBC_ symbol; null off glibc. */
  glibc: z.string().nullable(),
  napi: z.number().int().positive(),
  files: z.record(z.string().regex(SLOT_FILE), z.string().regex(SHA256))
})

const PrebuiltSlotManifestSchema = z.object({
  schemaVersion: z.literal(2),
  module: z.string(),
  version: z.string(),
  napi: z.number().int().positive(),
  slots: z.record(z.string(), PrebuiltSlotEntrySchema)
})

export type PrebuiltSlotEntry = z.infer<typeof PrebuiltSlotEntrySchema>
type PrebuiltSlotManifest = z.infer<typeof PrebuiltSlotManifestSchema>

type PrebuiltSlotRefusal =
  | 'no-slot'
  | 'no-prebuilds-dir'
  | 'no-manifest'
  | 'napi-unsupported'
  | 'libc-mismatch'
  | 'arch-mismatch'
  | 'glibc-too-old'
  | 'hash-mismatch'

export type PrebuiltSlotOutcome =
  | { installed: true; slot: string; spawnHelper: boolean }
  | { installed: false; slot: string; why: PrebuiltSlotRefusal; detail?: string }

/** Resolve beside the running bundle, independent of install location. */
export function resolveOrcadPrebuildsDir(entryScript = process.argv[1]): string | null {
  const override = process.env.ORCA_ORCAD_PREBUILDS_DIR
  if (override) {
    return override
  }
  return entryScript ? join(dirname(entryScript), 'prebuilds') : null
}

export function readPrebuiltSlotManifest(prebuildsDir: string): PrebuiltSlotManifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(prebuildsDir, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
  const parsed = PrebuiltSlotManifestSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Reject incompatible binaries before they obscure the missing-prebuilt diagnosis. */
function checkPrebuiltSlotEntry(
  entry: PrebuiltSlotEntry,
  abi: NativeHostAbi,
  hostNapi: number | null
): { why: PrebuiltSlotRefusal; detail: string } | null {
  if (entry.platform !== abi.platform || entry.arch !== abi.arch) {
    return {
      why: 'arch-mismatch',
      detail: `slot was built for ${entry.platform}/${entry.arch}, this host is ${abi.platform}/${abi.arch}`
    }
  }
  if (entry.libc !== abi.libc) {
    return {
      why: 'libc-mismatch',
      detail: `slot was built against ${entry.libc}, this host runs ${abi.libc}`
    }
  }
  if (hostNapi === null || hostNapi < entry.napi) {
    return {
      why: 'napi-unsupported',
      detail: `slot needs N-API ${entry.napi}, this Node supports ${hostNapi ?? 'no N-API version it reports'}`
    }
  }
  // Unknown glibc versions defer compatibility to the load probe.
  if (entry.glibc && abi.glibcVersion && compareDottedVersions(abi.glibcVersion, entry.glibc) < 0) {
    return {
      why: 'glibc-too-old',
      detail: `slot needs glibc ${entry.glibc}, this host has ${abi.glibcVersion}`
    }
  }
  return null
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function compatSlotsFor(slot: string): string[] {
  return COMPAT_SERVER_TARGETS.filter((compat) => COMPAT_SERVER_TARGET_BASES[compat] === slot)
}

type SlotChoice =
  | { slot: string; entry: PrebuiltSlotEntry }
  | { slot: string; why: PrebuiltSlotRefusal; detail?: string }

/** Try compat slots only for absence/old glibc; libc, arch and N-API refusals apply to both. */
function chooseSlot(
  manifest: PrebuiltSlotManifest,
  slot: string,
  abi: NativeHostAbi,
  hostNapi: number | null
): SlotChoice {
  const own = manifest.slots[slot]
  const ownRefusal = own ? checkPrebuiltSlotEntry(own, abi, hostNapi) : null
  if (own && !ownRefusal) {
    return { slot, entry: own }
  }
  if (!own || ownRefusal?.why === 'glibc-too-old') {
    for (const compat of compatSlotsFor(slot)) {
      const entry = manifest.slots[compat]
      if (entry && !checkPrebuiltSlotEntry(entry, abi, hostNapi)) {
        return { slot: compat, entry }
      }
    }
  }
  return ownRefusal ? { slot, ...ownRefusal } : { slot, why: 'no-slot' }
}

export function installPrebuiltSlot(options: {
  abi: NativeHostAbi
  nodePtyDir: string
  prebuildsDir?: string | null
  hostNapi?: number | null
}): PrebuiltSlotOutcome {
  const hostSlot = nativeSlotName(options.abi)
  const prebuildsDir = options.prebuildsDir ?? resolveOrcadPrebuildsDir()
  if (!prebuildsDir || !existsSync(prebuildsDir)) {
    return { installed: false, slot: hostSlot, why: 'no-prebuilds-dir' }
  }
  const manifest = readPrebuiltSlotManifest(prebuildsDir)
  if (!manifest) {
    return {
      installed: false,
      slot: hostSlot,
      why: 'no-manifest',
      detail: 'manifest.json is missing or not a schema 2 prebuild manifest'
    }
  }
  const hostNapi = options.hostNapi === undefined ? hostNodeApiVersion() : options.hostNapi
  const choice = chooseSlot(manifest, hostSlot, options.abi, hostNapi)
  if (!('entry' in choice)) {
    return { installed: false, ...choice }
  }
  const { slot, entry } = choice
  const files = Object.entries(entry.files)
  for (const [file, expected] of files) {
    const source = join(prebuildsDir, slot, ...file.split('/'))
    if (!existsSync(source) || sha256File(source) !== expected) {
      return {
        installed: false,
        slot,
        why: 'hash-mismatch',
        detail: `${slot}/${file} is missing or does not match its manifest sha256`
      }
    }
  }

  const releaseDir = join(options.nodePtyDir, 'build', 'Release')
  for (const [file] of files) {
    const destination = join(releaseDir, ...file.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(prebuildsDir, slot, ...file.split('/')), destination)
  }

  // macOS execs spawn-helper at terminal creation; validate it before claiming installation succeeded.
  const spawnHelper =
    usesNodePtySpawnHelper(options.abi.platform) && Object.hasOwn(entry.files, 'spawn-helper')
  if (spawnHelper) {
    chmodSync(join(releaseDir, 'spawn-helper'), 0o755)
  }
  return { installed: true, slot, spawnHelper }
}
