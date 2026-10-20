#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const sourcePath = path.join(repoRoot, 'native', 'speech-transcriber-macos', 'main.swift')
const defaultOutputPath = path.join(
  repoRoot,
  'native',
  'speech-transcriber-macos',
  '.build',
  'release',
  'orca-speech-transcriber'
)

if (process.platform !== 'darwin') {
  process.exit(0)
}

const args = process.argv.slice(2)
const outputPath = readArg('--output') ?? defaultOutputPath
const singleArch = args.includes('--single-arch')
const workDir = mkdtempSync(path.join(tmpdir(), 'orca-speech-transcriber-'))

try {
  const triples = singleArch
    ? [process.arch === 'arm64' ? 'arm64-apple-macosx' : 'x86_64-apple-macosx']
    : ['arm64-apple-macosx', 'x86_64-apple-macosx']
  const builtBinaries = triples.map((triple) => {
    const output = path.join(workDir, `orca-speech-transcriber-${triple}`)
    // Deployment target stays at the app's floor; every SpeechAnalyzer call in
    // the helper sits behind a macOS 26 availability check.
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

function readArg(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
