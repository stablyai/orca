import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

if (process.platform !== 'darwin') {
  process.exit(0)
}
const root = path.resolve(import.meta.dirname, '../..')
const args = process.argv.slice(2)
const outputIndex = args.indexOf('--output')
const output =
  outputIndex !== -1
    ? args[outputIndex + 1]
    : path.join(root, 'native/speech-macos/.build/release/orca-speech')
const architectures = args.includes('--single-arch')
  ? [process.arch === 'arm64' ? 'arm64' : 'x86_64']
  : ['arm64', 'x86_64']
const temporary = mkdtempSync(path.join(tmpdir(), 'orca-speech-build-'))
try {
  const sdkVersion = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-version'], {
    encoding: 'utf8'
  }).trim()
  if (Number.parseInt(sdkVersion, 10) < 26) {
    throw new Error('Building macOS Speech requires Xcode 26 or newer (macOS 26 SDK)')
  }
  const binaries = architectures.map((arch) => {
    const binary = path.join(temporary, arch)
    execFileSync(
      'swiftc',
      [
        '-O',
        '-parse-as-library',
        '-target',
        `${arch}-apple-macosx11.0`,
        path.join(root, 'native/speech-macos/main.swift'),
        '-o',
        binary
      ],
      { stdio: 'inherit' }
    )
    return binary
  })
  mkdirSync(path.dirname(output), { recursive: true })
  execFileSync('lipo', ['-create', ...binaries, '-output', output], { stdio: 'inherit' })
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
