import { posix, win32 } from 'node:path'
import { PLUGIN_SAVE_AS_BLOCKED_EXTENSIONS } from '../../shared/plugins/frames/plugin-save-as-extensions'

/** What a link click may do with a local file: hand it to the OS, show it as text in Orca, or reveal it. */
export type LinkedFileAction = 'open' | 'view-as-text' | 'reveal'

export type LinkedFileFacts = {
  /** The link's own path, each symlink hop, and the final target: the OS opens by the target's type. */
  names: readonly string[]
  isFile: boolean
  isDirectory: boolean
  mode: number
  /** The first bytes of a regular file; empty otherwise. */
  head: Uint8Array
}

// Script sources a runtime may be registered to run on double-click, beyond the shared blocked list.
const SCRIPT_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  'mjs',
  'cjs',
  'ts',
  'mts',
  'cts',
  'rb',
  'pl',
  'pm',
  'fish',
  'lua',
  'php',
  'tcl'
])

// Archives and packages: the OS default app unpacks them next to the file, so they are revealed instead.
const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'tbz',
  'tbz2',
  'xz',
  'txz',
  'zst',
  'lz',
  'lzma',
  'z',
  '7z',
  'rar',
  'cab',
  'war',
  'ear',
  'apk',
  'ipa',
  'xpi',
  'crx',
  'vsix',
  'nupkg'
])

function fileExtension(name: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    // Windows ignores trailing dots/spaces, and `a.exe:stream` still has the base file's type.
    const base = win32
      .basename(name)
      .split(':')[0]
      .replace(/[. ]+$/, '')
    return win32.extname(base).slice(1).toLowerCase()
  }
  return posix.extname(posix.basename(name)).slice(1).toLowerCase()
}

function isLaunchableExtension(
  extension: string,
  platform: NodeJS.Platform,
  windowsPathExt: string | undefined
): boolean {
  if (!extension) {
    return false
  }
  if (PLUGIN_SAVE_AS_BLOCKED_EXTENSIONS.has(extension) || SCRIPT_SOURCE_EXTENSIONS.has(extension)) {
    return true
  }
  return (
    platform === 'win32' &&
    (windowsPathExt ?? '')
      .toLowerCase()
      .split(';')
      .some((entry) => entry.trim() === `.${extension}`)
  )
}

function startsWith(head: Uint8Array, bytes: readonly number[]): boolean {
  return bytes.every((byte, index) => head[index] === byte)
}

function hasShebang(head: Uint8Array): boolean {
  return startsWith(head, [0x23, 0x21])
}

/** ELF, Mach-O (thin and universal) and PE headers. */
function isNativeExecutable(head: Uint8Array): boolean {
  return [
    [0x7f, 0x45, 0x4c, 0x46],
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
    [0x4d, 0x5a]
  ].some((magic) => startsWith(head, magic))
}

/** zip (and zip-based packages), gzip, bzip2, xz, zstd, 7z and rar. tar and cab headers carry NULs. */
function isArchiveContent(head: Uint8Array): boolean {
  const bzip2 = startsWith(head, [0x42, 0x5a, 0x68]) && head[3] >= 0x31 && head[3] <= 0x39
  return (
    bzip2 ||
    [
      [0x50, 0x4b, 0x03, 0x04],
      [0x50, 0x4b, 0x05, 0x06],
      [0x50, 0x4b, 0x07, 0x08],
      [0x1f, 0x8b],
      [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
      [0x28, 0xb5, 0x2f, 0xfd],
      [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
      [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]
    ].some((magic) => startsWith(head, magic))
  )
}

function isTextContent(head: Uint8Array): boolean {
  // UTF-16 text (common for .ps1/.reg on Windows) is full of NUL bytes but is still text.
  if (startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) {
    return true
  }
  return !head.includes(0) && !isNativeExecutable(head) && !isArchiveContent(head)
}

/**
 * Decide what a link click does. Opening in Orca's editor never runs anything, so a launchable
 * file that is readable text is shown there; launchable binaries, bundles and archives are revealed.
 */
export function classifyLinkedFile(
  { names, isFile, isDirectory, mode, head }: LinkedFileFacts,
  platform: NodeJS.Platform = process.platform,
  windowsPathExt: string | undefined = process.env.PATHEXT
): LinkedFileAction {
  const extensions = names.map((name) => fileExtension(name, platform))
  const launchableByName = extensions.some((extension) =>
    isLaunchableExtension(extension, platform, windowsPathExt)
  )
  if (isDirectory) {
    // `.app`, `.pkg`, `.workflow` and similar bundles are directories the OS runs or installs.
    return launchableByName ? 'reveal' : 'open'
  }
  if (!isFile) {
    return 'reveal'
  }
  if (extensions.some((extension) => ARCHIVE_EXTENSIONS.has(extension))) {
    return 'reveal'
  }
  if (launchableByName) {
    return isTextContent(head) ? 'view-as-text' : 'reveal'
  }
  if (platform === 'win32' || (mode & 0o111) === 0) {
    return 'open'
  }
  // Executable bit set. Content wins over the name: scripts and native programs never reach the OS.
  if (hasShebang(head)) {
    return 'view-as-text'
  }
  if (isNativeExecutable(head)) {
    return 'reveal'
  }
  if (extensions.some((extension) => extension === '')) {
    // macOS runs extensionless +x files in Terminal, treating text as a shell script.
    return isTextContent(head) ? 'view-as-text' : 'reveal'
  }
  // Typed documents are often +x on shared mounts (SMB, FAT, NTFS); the OS opens those by type.
  return 'open'
}
