// Include libc in prebuilt slots: node-pty’s platform/arch fallback can crash musl hosts with glibc binaries.
import process from 'node:process'

type LibcFlavor = 'glibc' | 'musl' | 'none'

export type NativeHostAbi = {
  platform: NodeJS.Platform
  arch: string
  libc: LibcFlavor
  /** Null on musl/non-Linux or unreadable reports. */
  glibcVersion: string | null
  nodeAbi: string
}

// Ubuntu 20.04 baseline.
export const GLIBC_FLOOR = '2.31'

type ReportHeader = { glibcVersionRuntime?: unknown }

/** Node omits glibcVersionRuntime on musl; non-Linux hosts need no libc slot dimension. */
export function detectLibcFromReportHeader(
  platform: NodeJS.Platform,
  header: unknown
): { libc: LibcFlavor; glibcVersion: string | null } {
  if (platform !== 'linux') {
    return { libc: 'none', glibcVersion: null }
  }
  if (!header || typeof header !== 'object') {
    // Unreadable reports do not prove musl; unknown glibc versions defer to the load probe.
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

export function hostNodeApiVersion(
  versions: NodeJS.ProcessVersions = process.versions
): number | null {
  const napi = Number.parseInt(versions.napi ?? '', 10)
  return Number.isInteger(napi) && napi > 0 ? napi : null
}

export function nativeSlotName(abi: Pick<NativeHostAbi, 'platform' | 'arch' | 'libc'>): string {
  return abi.libc === 'none'
    ? `${abi.platform}-${abi.arch}`
    : `${abi.platform}-${abi.arch}-${abi.libc}`
}

/** Numeric dotted comparison; missing components equal zero. */
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

/** Null preserves unknown versions instead of claiming they are below the floor. */
export function isBelowGlibcFloor(glibcVersion: string | null): boolean | null {
  if (!glibcVersion) {
    return null
  }
  return compareDottedVersions(glibcVersion, GLIBC_FLOOR) < 0
}

export function parseUnmetGlibcVersion(loaderError: string): string | null {
  const match = loaderError.match(/version `?GLIBC_([0-9][0-9.]*)'? not found/)
  return match ? match[1] : null
}

export function parseNodeAbiMismatch(loaderError: string): { built: string; host: string } | null {
  const match = loaderError.match(/NODE_MODULE_VERSION\s+(\d+)\D+NODE_MODULE_VERSION\s+(\d+)/)
  return match ? { built: match[1], host: match[2] } : null
}

/** ELF loader errors may establish wrong architecture without naming either side. */
export function parseIncompatibleArchitecture(
  loaderError: string
): { built: string | null; host: string | null } | null {
  const machO = loaderError.match(
    /incompatible architecture \(have '?([\w.]+)'?,?\s*need '?([\w.]+)'?/
  )
  if (machO) {
    return { built: machO[1], host: machO[2] }
  }
  if (/invalid ELF header|wrong ELF class|Exec format error|ELFCLASS(?:32|64)/.test(loaderError)) {
    return { built: null, host: null }
  }
  return null
}

/** Missing libraries can be installed; unavailable glibc symbol versions require rebuilding. */
export function parseMissingSharedLibrary(loaderError: string): string | null {
  const elf = loaderError.match(/([\w.+-]+\.so[\w.]*): cannot open shared object file/)
  if (elf) {
    return elf[1]
  }
  const musl = loaderError.match(/Error loading shared library ([\w.+-]+\.so[\w.]*)/)
  if (musl) {
    return musl[1]
  }
  const machO = loaderError.match(/Library not loaded:\s*(\S+)/)
  return machO ? machO[1] : null
}
