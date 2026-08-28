/**
 * What this host would load a native addon against: platform, arch, libc flavour and
 * Node's ABI number, plus the prebuild slot name those four pick.
 *
 * Why libc is a first-class dimension: node-pty's own loader
 * (`node_modules/node-pty/lib/utils.js`) falls back to `prebuilds/<platform>-<arch>`,
 * which does NOT distinguish glibc from musl. A glibc binary dropped in that directory
 * is loaded on Alpine and dies inside the dynamic loader. Slot names carry the libc so
 * a mismatch is a miss rather than a crash.
 *
 * Everything here is pure apart from `detectNativeHostAbi`, so the classification can be
 * tested for hosts this machine is not.
 */
import process from 'node:process'

export type LibcFlavor = 'glibc' | 'musl' | 'none'

export type NativeHostAbi = {
  platform: NodeJS.Platform
  arch: string
  libc: LibcFlavor
  /** Runtime glibc version ('2.31'), or null on musl, non-Linux, and unreadable reports. */
  glibcVersion: string | null
  /** `NODE_MODULE_VERSION` — the addon ABI this runtime accepts. */
  nodeAbi: string
}

/** Stock Ubuntu 20.04. See docs/reference/linux-glibc-compatibility.md. */
export const GLIBC_FLOOR = '2.31'

type ReportHeader = { glibcVersionRuntime?: unknown }

/**
 * Why absence means musl: `glibcVersionRuntime` is written by Node's report only when the
 * process is linked against glibc. Alpine's Node omits it. This avoids shelling out to
 * `ldd`, which is not present on every image and prints to stderr on musl.
 *
 * Non-Linux hosts get 'none': macOS and Windows have one system libc, so the dimension
 * carries no information and must not widen the slot matrix.
 */
export function detectLibcFromReportHeader(
  platform: NodeJS.Platform,
  header: unknown
): { libc: LibcFlavor; glibcVersion: string | null } {
  if (platform !== 'linux') {
    return { libc: 'none', glibcVersion: null }
  }
  if (!header || typeof header !== 'object') {
    // Why glibc and not 'unknown': an unreadable report is not evidence of musl, and
    // glibc is the overwhelmingly common Linux case. The null version keeps the floor
    // check from claiming a number it does not have.
    return { libc: 'glibc', glibcVersion: null }
  }
  const runtime = (header as ReportHeader).glibcVersionRuntime
  if (typeof runtime === 'string' && runtime.length > 0) {
    return { libc: 'glibc', glibcVersion: runtime }
  }
  if ('glibcVersionRuntime' in (header as object)) {
    return { libc: 'glibc', glibcVersion: null }
  }
  return { libc: 'musl', glibcVersion: null }
}

export function detectNativeHostAbi(): NativeHostAbi {
  let header: unknown
  try {
    header = (process.report?.getReport?.() as { header?: unknown } | undefined)?.header
  } catch {
    header = undefined
  }
  const { libc, glibcVersion } = detectLibcFromReportHeader(process.platform, header)
  return {
    platform: process.platform,
    arch: process.arch,
    libc,
    glibcVersion,
    nodeAbi: process.versions.modules
  }
}

/** `linux-x64-glibc`, `linux-arm64-musl`, `darwin-arm64`, `win32-x64`. */
export function nativeSlotName(abi: Pick<NativeHostAbi, 'platform' | 'arch' | 'libc'>): string {
  return abi.libc === 'none'
    ? `${abi.platform}-${abi.arch}`
    : `${abi.platform}-${abi.arch}-${abi.libc}`
}

/** Numeric dotted compare: -1 / 0 / 1. Missing components read as 0, so '2.31' === '2.31.0'. */
export function compareDottedVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const b = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) {
      return diff > 0 ? 1 : -1
    }
  }
  return 0
}

/** Null when the version is unknown — an unread report must not read as "below the floor". */
export function isBelowGlibcFloor(glibcVersion: string | null): boolean | null {
  if (!glibcVersion) {
    return null
  }
  return compareDottedVersions(glibcVersion, GLIBC_FLOOR) < 0
}

/**
 * The symbol version node's loader complained about, e.g.
 * `libc.so.6: version 'GLIBC_2.34' not found (required by .../pty.node)` -> '2.34'.
 * This is the fingerprint of #9902: a binary built on a newer glibc than the target.
 */
export function parseUnmetGlibcVersion(loaderError: string): string | null {
  const match = loaderError.match(/version `?GLIBC_([0-9][0-9.]*)'? not found/)
  return match ? match[1] : null
}

/** `NODE_MODULE_VERSION 115 ... requires NODE_MODULE_VERSION 127` -> { built: '115', host: '127' }. */
export function parseNodeAbiMismatch(loaderError: string): { built: string; host: string } | null {
  const match = loaderError.match(/NODE_MODULE_VERSION\s+(\d+)\D+NODE_MODULE_VERSION\s+(\d+)/)
  return match ? { built: match[1], host: match[2] } : null
}
