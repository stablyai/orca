/**
 * Install the shipped node-pty prebuilt that matches this host, so a deployment needs
 * no C/C++ toolchain.
 *
 * Why copy into `build/Release` rather than leave it in `prebuilds/`: node-pty's own
 * loader falls back to `prebuilds/<platform>-<arch>` with no libc in the name, so a
 * glibc binary parked there is loaded on Alpine and dies in the dynamic loader. Putting
 * the chosen slot's binary in `build/Release` is what makes the libc dimension real —
 * node-pty only ever sees the one we picked.
 *
 * The prebuilds themselves are built from the PATCHED source (config/patches/node-pty@1.1.0.patch)
 * by config/scripts/build-orcad-prebuilds.mjs. An upstream tarball would not do: the patch
 * carries the `.symver` pins and the `--no-as-needed` libutil/libpthread flags that hold the
 * glibc 2.28 server-slot floor (docs/reference/linux-glibc-compatibility.md).
 *
 * The gate is N-API + libc + arch, not NODE_MODULE_VERSION: the slots are Node-API addons,
 * so one build loads on the pinned Node and on any host Node whose N-API level is at least
 * the slot's (design D2/D6 rung C).
 */
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
// Why: slot-relative POSIX paths only, so a tampered manifest cannot write outside build/Release.
const SLOT_FILE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[\w.-]+(?:\/[\w.-]+)*$/

const PrebuiltSlotEntrySchema = z.object({
  platform: z.string(),
  arch: z.string(),
  libc: z.enum(['glibc', 'musl', 'none']),
  /** Highest strong GLIBC_ symbol version the slot needs; null off glibc. */
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
export type PrebuiltSlotManifest = z.infer<typeof PrebuiltSlotManifestSchema>

export type PrebuiltSlotRefusal =
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

/**
 * Where a deployment's prebuilds live: beside the bundle that is running. `argv[1]` is
 * `orcad.js` itself, so this stays correct wherever the install directory ends up.
 */
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

/**
 * Why each check refuses instead of copying: a binary this host cannot load would replace
 * a "no usable prebuilt" diagnosis with a loader failure that reads as a corrupt install.
 */
export function checkPrebuiltSlotEntry(
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
  // An unread host version is not evidence of an old glibc; the load probe decides then.
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

/** Compat slots (design D6 rung B) tried after `slot`'s own, e.g. linux-x64-glibc217 for linux-x64-glibc. */
export function compatSlotsFor(slot: string): string[] {
  return COMPAT_SERVER_TARGETS.filter((compat) => COMPAT_SERVER_TARGET_BASES[compat] === slot)
}

type SlotChoice =
  | { slot: string; entry: PrebuiltSlotEntry }
  | { slot: string; why: PrebuiltSlotRefusal; detail?: string }

/**
 * The host's own slot, or a compat slot when the own one is missing or needs a newer glibc.
 * Why only those two: any other refusal (libc, arch, N-API) holds for the compat slot too.
 */
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

/**
 * Copy every file the manifest lists for this host's slot (or its compat slot) into node-pty's
 * `build/Release`, after checking N-API, libc, arch, glibc and each file's sha256.
 */
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

  // Why this matters as much as pty.node: on macOS node-pty posix_spawns
  // build/Release/spawn-helper. Without it every spawn fails with ENOENT at the moment
  // a user opens a terminal, long after the "install succeeded" line.
  const spawnHelper =
    usesNodePtySpawnHelper(options.abi.platform) && Object.hasOwn(entry.files, 'spawn-helper')
  if (spawnHelper) {
    chmodSync(join(releaseDir, 'spawn-helper'), 0o755)
  }
  return { installed: true, slot, spawnHelper }
}
