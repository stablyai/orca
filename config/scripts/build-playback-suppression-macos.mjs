#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

if (process.platform !== 'darwin') {
  process.exit(0)
}

const repoRoot = path.resolve(import.meta.dirname, '../..')
const sourcePath = path.join(repoRoot, 'native', 'playback-suppression-macos', 'main.swift')
const outputPath =
  readArg('--output') ??
  path.join(
    repoRoot,
    'native',
    'playback-suppression-macos',
    '.build',
    'release',
    'orca-playback-suppression'
  )
const singleArch = process.argv.includes('--single-arch')
const workDir = path.join(tmpdir(), `orca-playback-suppression-${process.pid}`)
mkdirSync(workDir, { recursive: true })
try {
  const triples = singleArch
    ? [process.arch === 'arm64' ? 'arm64-apple-macosx' : 'x86_64-apple-macosx']
    : ['arm64-apple-macosx', 'x86_64-apple-macosx']
  const binaries = triples.map((triple) => {
    const binaryPath = path.join(workDir, triple)
    execFileSync(
      'swiftc',
      [
        '-O',
        sourcePath,
        '-target',
        triple.replace('-apple-macosx', '-apple-macosx11.0'),
        '-framework',
        'CoreAudio',
        '-o',
        binaryPath
      ],
      { stdio: 'inherit' }
    )
    return binaryPath
  })
  mkdirSync(path.dirname(outputPath), { recursive: true })
  if (binaries.length === 1) {
    execFileSync('cp', [binaries[0], outputPath])
  } else {
    execFileSync('lipo', ['-create', ...binaries, '-output', outputPath])
  }
  execFileSync('chmod', ['755', outputPath])
  verifySnapshotContract(execFileSync(outputPath, ['self-test'], { encoding: 'utf8' }))
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

function verifySnapshotContract(stdout) {
  const snapshot = JSON.parse(stdout)
  if (
    snapshot.endpointId !== 'orca-test-endpoint' ||
    snapshot.endpointTarget !== 'orca-test-endpoint' ||
    snapshot.muted !== false
  ) {
    throw new Error('macOS playback suppression helper returned an invalid self-test snapshot.')
  }
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
