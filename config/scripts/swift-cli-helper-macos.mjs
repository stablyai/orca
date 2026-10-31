import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')

/** Builds a single-file Swift CLI helper from native/<nativeDir>/main.swift (universal unless --single-arch). */
export function buildSwiftCliHelper({ nativeDir, executable, argv }) {
  if (process.platform !== 'darwin') {
    return
  }
  const sourcePath = path.join(repoRoot, 'native', nativeDir, 'main.swift')
  const outputPath =
    readArg(argv, '--output') ??
    path.join(repoRoot, 'native', nativeDir, '.build', 'release', executable)
  const triples = argv.includes('--single-arch')
    ? [process.arch === 'arm64' ? 'arm64-apple-macosx' : 'x86_64-apple-macosx']
    : ['arm64-apple-macosx', 'x86_64-apple-macosx']
  const workDir = mkdtempSync(path.join(tmpdir(), `${executable}-`))
  try {
    const builtBinaries = triples.map((triple) => {
      const output = path.join(workDir, `${executable}-${triple}`)
      execFileSync(
        'swiftc',
        [
          '-O',
          sourcePath,
          '-target',
          triple.replace('-apple-macosx', '-apple-macosx11.0'),
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
    chmodSync(outputPath, 0o755)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

const DEV_SWIFT_CLI_HELPERS = [
  [
    'keyboard-layout-macos',
    'orca-keyboard-layout',
    'shifted Option composition stays conservative'
  ],
  ['process-footprint-macos', 'orca-process-footprint', 'memory panel falls back to top']
]

/** Dev bundles build each helper for the host arch; a missing swiftc only degrades that helper's feature. */
export function buildDevSwiftCliHelpers(macOsDir) {
  for (const [nativeDir, executable, fallback] of DEV_SWIFT_CLI_HELPERS) {
    try {
      buildSwiftCliHelper({
        nativeDir,
        executable,
        argv: ['--single-arch', '--output', path.join(macOsDir, executable)]
      })
    } catch (error) {
      console.warn(
        `[orca-dev] ${executable} helper build failed (${fallback}): ${error?.message ?? error}`
      )
    }
  }
}

function readArg(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
