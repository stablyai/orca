#!/usr/bin/env node
// Builds a macOS 12-compatible serve-sim-bin helper.
//
// The serve-sim npm package ships serve-sim-bin with a macOS 14.0 deployment
// target, so on macOS 12/13 it dies at dyld with missing Foundation symbols
// (see issue #22470). The stream helper's Swift source is only published in the
// upstream repo (before it moved to a Swift 6 node addon), so this pins that
// revision plus Swifter and compiles both architectures against macOS 12.
// Requires network access to github.com and an Xcode toolchain, like the other
// build-*-macos.mjs helpers.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Why: last upstream commit that still contains Sources/SimStreamHelper; the
// stream/HID/AX protocol matches the JS shipped in serve-sim 0.1.40.
const SERVE_SIM_REPO = 'https://github.com/EvanBacon/serve-sim.git'
const SERVE_SIM_REF = '55bb294260095ae7bc6287fa0934f2b527d75f52'
const SWIFTER_REPO = 'https://github.com/httpswift/swifter.git'
const SWIFTER_REF = '9483a5d459b45c3ffd059f7b55f9638e268632fd'
const MIN_MACOS = '12.0'

// Why: Xcode SDKs older than 14.x do not export proc_pidpath through Darwin.
const PROC_PIDPATH_SHIM = `import Darwin
@_silgen_name("proc_pidpath")
func proc_pidpath(_ pid: Int32, _ buffer: UnsafeMutableRawPointer!, _ size: UInt32) -> Int32
`

const repoRoot = path.resolve(import.meta.dirname, '../..')
const defaultOutputPath = path.join(
  repoRoot,
  'native',
  'serve-sim-helper-macos',
  '.build',
  'release',
  'serve-sim-bin'
)

if (process.platform !== 'darwin') {
  process.exit(0)
}

const args = process.argv.slice(2)
const outputPath = readArg('--output') ?? defaultOutputPath
// Why: dev launches only need the host architecture; release builds ship a
// universal binary matching the app's x64 + arm64 targets.
const singleArch = args.includes('--single-arch')
const arches = singleArch ? [process.arch === 'arm64' ? 'arm64' : 'x86_64'] : ['arm64', 'x86_64']

const workDir = path.join(tmpdir(), `orca-serve-sim-helper-${process.pid}`)
mkdirSync(workDir, { recursive: true })
try {
  const serveSimDir = fetchAtRef(SERVE_SIM_REPO, SERVE_SIM_REF, 'serve-sim')
  const swifterDir = fetchAtRef(SWIFTER_REPO, SWIFTER_REF, 'swifter')
  const helperSources = swiftFiles(
    path.join(serveSimDir, 'packages/serve-sim/Sources/SimStreamHelper')
  )
  const swifterSources = swiftFiles(path.join(swifterDir, 'XCode/Sources')).filter(
    (file) => path.basename(file) !== 'DemoServer.swift'
  )
  const shimPath = path.join(workDir, 'proc-pidpath-shim.swift')
  writeFileSync(shimPath, PROC_PIDPATH_SHIM, 'utf8')

  const builtBinaries = arches.map((arch) => {
    const target = `${arch}-apple-macos${MIN_MACOS}`
    const archDir = path.join(workDir, arch)
    mkdirSync(archDir, { recursive: true })
    // Why: Swifter is compiled as a static module so the helper sources can
    // `import Swifter` without SwiftPM (the package manifest needs tools 5.9+).
    execFileSync(
      'swiftc',
      [
        '-O',
        '-target',
        target,
        '-swift-version',
        '5',
        '-parse-as-library',
        '-emit-library',
        '-static',
        '-module-name',
        'Swifter',
        '-emit-module',
        '-emit-module-path',
        path.join(archDir, 'Swifter.swiftmodule'),
        ...swifterSources,
        '-o',
        path.join(archDir, 'libSwifter.a')
      ],
      { stdio: 'inherit' }
    )
    const output = path.join(archDir, 'serve-sim-bin')
    execFileSync(
      'swiftc',
      [
        '-O',
        '-target',
        target,
        '-swift-version',
        '5',
        '-module-name',
        'serve_sim_bin',
        '-I',
        archDir,
        ...helperSources,
        shimPath,
        path.join(archDir, 'libSwifter.a'),
        '-framework',
        'VideoToolbox',
        '-framework',
        'CoreMedia',
        '-framework',
        'CoreVideo',
        '-framework',
        'IOSurface',
        '-framework',
        'CoreGraphics',
        '-o',
        output
      ],
      { stdio: 'inherit' }
    )
    return output
  })

  mkdirSync(path.dirname(outputPath), { recursive: true })
  if (builtBinaries.length === 1) {
    execFileSync('cp', [builtBinaries[0], outputPath])
  } else {
    execFileSync('lipo', ['-create', ...builtBinaries, '-output', outputPath])
  }
  execFileSync('chmod', ['755', outputPath])
  // Why: the private-framework loading needs a signature; electron-builder
  // re-signs release builds, this keeps dev/local builds launchable.
  execFileSync('codesign', ['-s', '-', '-f', outputPath], { stdio: 'ignore' })
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

function fetchAtRef(repoUrl, ref, name) {
  const dir = path.join(workDir, name)
  mkdirSync(dir, { recursive: true })
  const git = (...gitArgs) => execFileSync('git', ['-C', dir, ...gitArgs], { stdio: 'inherit' })
  git('init', '-q')
  git('fetch', '-q', '--depth', '1', repoUrl, ref)
  git('checkout', '-q', 'FETCH_HEAD')
  return dir
}

function swiftFiles(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.swift'))
    .sort()
    .map((file) => path.join(dir, file))
}

function readArg(name) {
  const index = args.indexOf(name)
  return index !== -1 ? args[index + 1] : undefined
}
