import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from './script-child-process.mjs'
import { getZipExtractorCommand } from './zip-extractor-command.mjs'

export const GUEST_TREE_KILL_ZIG_VERSION = '0.16.0'
// Official immutable assets: https://ziglang.org/download/index.json (0.16.0).
export const ZIG_ASSETS = {
  'linux-x64': ['x86_64-linux', '70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00'],
  'linux-arm64': [
    'aarch64-linux',
    'ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17'
  ],
  'darwin-x64': [
    'x86_64-macos',
    '0387557ed1877bc6a2e1802c8391953baddba76081876301c522f52977b52ba7'
  ],
  'darwin-arm64': [
    'aarch64-macos',
    'b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489'
  ],
  'win32-x64': [
    'x86_64-windows',
    '68659eb5f1e4eb1437a722f1dd889c5a322c9954607f5edcf337bc3684a75a7e'
  ],
  'win32-arm64': [
    'aarch64-windows',
    'aee38316ee4111717900f45dd3130145c39289e105541d737eb8c5ed653c78ef'
  ]
}

export function zigAsset(platform = process.platform, arch = process.arch) {
  const asset = ZIG_ASSETS[`${platform}-${arch}`]
  if (!asset) {
    throw new Error(`No pinned guest-helper compiler for ${platform}-${arch}`)
  }
  const name = `zig-${asset[0]}-${GUEST_TREE_KILL_ZIG_VERSION}`
  return { name, sha256: asset[1], archive: `${name}.${platform === 'win32' ? 'zip' : 'tar.xz'}` }
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Re-extract the checksum-verified archive before use, rather than trusting mutable extracted code. */
export async function withGuestTreeKillCompiler(root, callback) {
  const asset = zigAsset()
  const cache = join(root, 'out', '.guest-tree-kill-toolchain')
  mkdirSync(cache, { recursive: true })
  const archive = process.env.ORCA_GUEST_TREE_KILL_ZIG_ARCHIVE || join(cache, asset.archive)
  if (!existsSync(archive)) {
    if (process.env.ORCA_GUEST_TREE_KILL_ZIG_ARCHIVE) {
      throw new Error(`Missing compiler archive: ${archive}`)
    }
    const response = await fetch(
      `https://ziglang.org/download/${GUEST_TREE_KILL_ZIG_VERSION}/${asset.archive}`,
      { signal: AbortSignal.timeout(120_000) }
    )
    if (!response.ok) {
      throw new Error(`Zig download failed: ${response.status}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
      throw new Error('Zig archive checksum mismatch')
    }
    writeFileSync(archive, bytes)
  }
  if (digest(archive) !== asset.sha256) {
    throw new Error(`Zig archive checksum mismatch: ${archive}`)
  }
  const temporary = mkdtempSync(join(tmpdir(), 'orca-guest-compiler-'))
  try {
    const command = asset.archive.endsWith('.zip')
      ? getZipExtractorCommand(archive, temporary)
      : { file: 'tar', args: ['-xf', archive, '-C', temporary] }
    const result = runProcessSync({
      program: command.file,
      args: command.args,
      timeoutMs: 120_000,
      maxOutputBytes: 64 * 1024
    })
    if (result.code !== 0) {
      throw new Error(`Zig extraction failed: ${result.stderr}`)
    }
    const directory = join(temporary, asset.name)
    const executable = join(directory, process.platform === 'win32' ? 'zig.exe' : 'zig')
    return await callback(executable, directory)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
