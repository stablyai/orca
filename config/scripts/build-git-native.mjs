import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', '..')
const crateDir = path.join(root, 'native', 'git-native')
const outDir = path.join(crateDir, '.build')

function hasCargo() {
  try {
    execFileSync('cargo', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function hasRustup() {
  try {
    execFileSync('rustup', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function hostLibName() {
  if (process.platform === 'win32') {
    return 'git_native.dll'
  }
  if (process.platform === 'darwin') {
    return 'libgit_native.dylib'
  }
  return 'libgit_native.so'
}

if (!hasCargo()) {
  // Why: contributors without a Rust toolchain must still build and run Orca;
  // the runtime degrades to CLI git when the addon is absent.
  console.warn('[git-native] cargo not found; skipping (runtime falls back to git CLI)')
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
const target = path.join(outDir, 'git-native.node')
// Why: a failed build must not leave the previous addon behind, or a later
// cargo-less run would let the runtime load a stale .node instead of CLI git.
rmSync(target, { force: true })

if (process.platform === 'darwin' && process.env.ORCA_MAC_RELEASE === '1') {
  if (!hasRustup()) {
    console.error('[git-native] rustup not found; the mac release dual-arch build requires rustup')
    process.exit(1)
  }
  // Why: mac release packages both arches from one build host; a single-arch
  // .node would silently fall back to CLI on the other arch.
  for (const triple of ['aarch64-apple-darwin', 'x86_64-apple-darwin']) {
    execFileSync('rustup', ['target', 'add', triple], { cwd: crateDir, stdio: 'inherit' })
    execFileSync('cargo', ['build', '--release', '--target', triple], {
      cwd: crateDir,
      stdio: 'inherit'
    })
  }
  execFileSync(
    'lipo',
    [
      '-create',
      path.join(crateDir, 'target', 'aarch64-apple-darwin', 'release', 'libgit_native.dylib'),
      path.join(crateDir, 'target', 'x86_64-apple-darwin', 'release', 'libgit_native.dylib'),
      '-output',
      target
    ],
    { stdio: 'inherit' }
  )
} else {
  execFileSync('cargo', ['build', '--release'], { cwd: crateDir, stdio: 'inherit' })
  copyFileSync(path.join(crateDir, 'target', 'release', hostLibName()), target)
}

console.log(`[git-native] built ${target}`)
