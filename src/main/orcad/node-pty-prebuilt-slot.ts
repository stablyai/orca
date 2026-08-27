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
 * Ubuntu 20.04 / glibc 2.31 floor (docs/reference/linux-glibc-compatibility.md).
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { nativeSlotName, type NativeHostAbi } from './native-host-abi'

export type PrebuiltSlotManifest = {
  module: string
  version: string
  nodeAbi: string
  slots: string[]
}

export type PrebuiltSlotOutcome =
  | { installed: true; slot: string; spawnHelper: boolean }
  | { installed: false; slot: string; why: 'no-slot' | 'no-prebuilds-dir' | 'abi-mismatch'; detail?: string }

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
  try {
    const parsed = JSON.parse(readFileSync(join(prebuildsDir, 'manifest.json'), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return null
    }
    const manifest = parsed as Partial<PrebuiltSlotManifest>
    if (typeof manifest.nodeAbi !== 'string' || typeof manifest.version !== 'string') {
      return null
    }
    return {
      module: typeof manifest.module === 'string' ? manifest.module : 'node-pty',
      version: manifest.version,
      nodeAbi: manifest.nodeAbi,
      slots: Array.isArray(manifest.slots) ? manifest.slots.filter((s) => typeof s === 'string') : []
    }
  } catch {
    return null
  }
}

/**
 * Copy `<prebuilds>/<slot>/pty.node` (and `spawn-helper`) into node-pty's `build/Release`.
 *
 * Refuses on an ABI mismatch instead of copying: a binary built for another
 * `NODE_MODULE_VERSION` cannot load, and installing it would replace a "no prebuilt"
 * diagnosis with a loader failure that reads as a corrupt install.
 */
export function installPrebuiltSlot(options: {
  abi: NativeHostAbi
  nodePtyDir: string
  prebuildsDir?: string | null
}): PrebuiltSlotOutcome {
  const slot = nativeSlotName(options.abi)
  const prebuildsDir = options.prebuildsDir ?? resolveOrcadPrebuildsDir()
  if (!prebuildsDir || !existsSync(prebuildsDir)) {
    return { installed: false, slot, why: 'no-prebuilds-dir' }
  }
  const manifest = readPrebuiltSlotManifest(prebuildsDir)
  if (manifest && manifest.nodeAbi !== options.abi.nodeAbi) {
    return {
      installed: false,
      slot,
      why: 'abi-mismatch',
      detail: `shipped prebuilds target Node ABI ${manifest.nodeAbi}, this host runs ABI ${options.abi.nodeAbi}`
    }
  }
  const source = join(prebuildsDir, slot, 'pty.node')
  if (!existsSync(source)) {
    return { installed: false, slot, why: 'no-slot' }
  }
  const releaseDir = join(options.nodePtyDir, 'build', 'Release')
  mkdirSync(releaseDir, { recursive: true })
  copyFileSync(source, join(releaseDir, 'pty.node'))

  // Why this matters as much as pty.node: on Unix node-pty posix_spawns
  // build/Release/spawn-helper. Without it every spawn fails with ENOENT at the moment
  // a user opens a terminal, long after the "install succeeded" line.
  let spawnHelper = false
  if (options.abi.platform !== 'win32') {
    const helperSource = join(prebuildsDir, slot, 'spawn-helper')
    if (existsSync(helperSource)) {
      const helperDest = join(releaseDir, 'spawn-helper')
      copyFileSync(helperSource, helperDest)
      chmodSync(helperDest, 0o755)
      spawnHelper = true
    }
  }
  return { installed: true, slot, spawnHelper }
}
