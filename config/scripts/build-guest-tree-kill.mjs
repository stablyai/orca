import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { runProcessSync } from './script-child-process.mjs'
import {
  GUEST_TREE_KILL_ZIG_VERSION,
  withGuestTreeKillCompiler
} from './guest-tree-kill-toolchain.mjs'
import {
  readGuestTreeKillManifest,
  assertGuestTreeKillArtifacts,
  assertStaticGuestTreeKillElf,
  guestTreeKillSha256,
  GUEST_TREE_KILL_BINARY,
  GUEST_TREE_KILL_PLATFORMS
} from './guest-tree-kill-artifact-validation.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const FLAGS = [
  '-std=c11',
  '-Os',
  '-static',
  '-fno-pie',
  '-no-pie',
  '-s',
  '-Wall',
  '-Wextra',
  '-Werror'
]
const TARGETS = { 'linux-x64': 'x86_64-linux.5.1-musl', 'linux-arm64': 'aarch64-linux.5.1-musl' }

export function guestTreeKillSourceHash(root = ROOT) {
  const directory = join(root, 'native', 'linux-guest-tree-kill')
  const files = readdirSync(directory)
    .filter((name) => /\.[ch]$/.test(name) && !name.endsWith('.test.c'))
    .sort()
  const hash = createHash('sha256').update(
    JSON.stringify({ zig: GUEST_TREE_KILL_ZIG_VERSION, flags: FLAGS, targets: TARGETS })
  )
  for (const name of files) {
    hash.update(name).update(readFileSync(join(directory, name), 'utf8').replaceAll('\r\n', '\n'))
  }
  return hash.digest('hex')
}

export function assertGuestTreeKillBuildFresh(directory, root = ROOT) {
  assertGuestTreeKillArtifacts(directory)
  const manifest = readGuestTreeKillManifest(directory)
  if (manifest.sourceSha256 !== guestTreeKillSourceHash(root)) {
    throw new Error('Guest cleanup helper is stale; run pnpm build:guest-tree-kill')
  }
  for (const name of ['musl-COPYRIGHT', 'zig-LICENSE']) {
    if (!existsSync(join(directory, 'licenses', name))) {
      throw new Error(`Missing guest cleanup helper license: ${name}`)
    }
  }
}

export async function buildGuestTreeKill({
  root = ROOT,
  output = join(root, 'resources', 'guest-tree-kill'),
  force = false
} = {}) {
  if (!force) {
    try {
      assertGuestTreeKillBuildFresh(output, root)
      return output
    } catch {
      /* Rebuild missing, stale or corrupt artifacts. */
    }
  }
  const sourceSha256 = guestTreeKillSourceHash(root)
  mkdirSync(dirname(output), { recursive: true })
  const staging = mkdtempSync(`${output}.staging-`)
  try {
    await withGuestTreeKillCompiler(root, async (compiler, toolchainRoot) => {
      const artifacts = {}
      for (const platform of GUEST_TREE_KILL_PLATFORMS) {
        const path = join(staging, platform, GUEST_TREE_KILL_BINARY)
        mkdirSync(dirname(path), { recursive: true })
        const result = runProcessSync({
          program: compiler,
          args: [
            'cc',
            ...FLAGS,
            '-target',
            TARGETS[platform],
            `-ffile-prefix-map=${root}=.`,
            join(root, 'native', 'linux-guest-tree-kill', 'main.c'),
            '-o',
            path
          ],
          cwd: root,
          env: {
            ...process.env,
            ZIG_GLOBAL_CACHE_DIR: join(root, 'out', '.guest-tree-kill-zig-cache'),
            ZIG_LOCAL_CACHE_DIR: join(staging, '.zig-cache')
          },
          timeoutMs: 180_000,
          maxOutputBytes: 128 * 1024
        })
        if (result.code !== 0 || result.timedOut) {
          throw new Error(`Guest helper ${platform} build failed: ${result.stderr}`)
        }
        const bytes = readFileSync(path)
        assertStaticGuestTreeKillElf(bytes, platform)
        chmodSync(path, 0o755)
        artifacts[platform] = { sha256: guestTreeKillSha256(bytes) }
      }
      const licenses = join(staging, 'licenses')
      mkdirSync(licenses)
      cpSync(join(toolchainRoot, 'LICENSE'), join(licenses, 'zig-LICENSE'))
      cpSync(
        join(toolchainRoot, 'lib', 'libc', 'musl', 'COPYRIGHT'),
        join(licenses, 'musl-COPYRIGHT')
      )
      rmSync(join(staging, '.zig-cache'), { recursive: true, force: true })
      writeFileSync(
        join(staging, 'manifest.json'),
        `${JSON.stringify(
          { version: 1, compiler: `zig-${GUEST_TREE_KILL_ZIG_VERSION}`, sourceSha256, artifacts },
          null,
          2
        )}\n`
      )
    })
    assertGuestTreeKillBuildFresh(staging, root)
    rmSync(output, { recursive: true, force: true })
    renameSync(staging, output)
    return output
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const rootIndex = process.argv.indexOf('--artifact-root')
  const output =
    rootIndex === -1
      ? join(ROOT, 'resources', 'guest-tree-kill')
      : resolve(process.argv[rootIndex + 1])
  if (process.argv.includes('--check')) {
    assertGuestTreeKillBuildFresh(output)
  } else if (!process.argv.includes('--windows-only') || process.platform === 'win32') {
    await buildGuestTreeKill({ output, force: process.argv.includes('--force') })
  }
}
