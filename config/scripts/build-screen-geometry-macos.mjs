#!/usr/bin/env node
// Builds the orca-screen-geometry helper binary.
//
// Mirrors build-notification-status-macos.mjs, minus the embedded Info.plist: that helper
// needs a code identity because macOS keys notification records to it, whereas this one only
// reads NSScreen and can ship in Resources with no bundle identity at all.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const sourcePath = path.join(repoRoot, 'native', 'screen-geometry-macos', 'main.swift')
const defaultOutputPath = path.join(
  repoRoot,
  'native',
  'screen-geometry-macos',
  '.build',
  'release',
  'orca-screen-geometry'
)

if (process.platform !== 'darwin') {
  process.exit(0)
}

const args = process.argv.slice(2)
const outputPath = readArg('--output') ?? defaultOutputPath
// Why: dev launches only need the host architecture; release builds ship a universal binary.
const singleArch = args.includes('--single-arch')

const workDir = path.join(tmpdir(), `orca-screen-geometry-${process.pid}`)
mkdirSync(workDir, { recursive: true })
try {
  const triples = singleArch
    ? [process.arch === 'arm64' ? 'arm64-apple-macosx' : 'x86_64-apple-macosx']
    : ['arm64-apple-macosx', 'x86_64-apple-macosx']
  const builtBinaries = triples.map((triple) => {
    const output = path.join(workDir, `orca-screen-geometry-${triple}`)
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
  execFileSync('chmod', ['755', outputPath])
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

function readArg(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
