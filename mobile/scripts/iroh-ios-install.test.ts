import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ios = new URL('../packages/expo-iroh/ios/', import.meta.url)
const installer = fs.readFileSync(new URL('install-bindings.sh', ios), 'utf8')
const podspec = fs.readFileSync(new URL('ExpoIroh.podspec', ios), 'utf8')
const hasRuby = spawnSync('ruby', ['--version']).status === 0
let root: string
let native: string
let archive: string
let bindings: string
let env: NodeJS.ProcessEnv

function run(command = 'bash', args = [path.join(native, 'install-bindings.sh')]) {
  return spawnSync(command, args, { env, encoding: 'utf8' })
}

function install() {
  const result = run()
  expect(result.stderr).not.toContain('checksum mismatch')
  expect(result.status).toBe(0)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'iroh-ios-install-'))
  native = path.join(root, 'ios')
  archive = path.join(root, 'release.zip')
  bindings = path.join(root, 'IrohLib.swift')
  const framework = path.join(root, 'fixture/Iroh/Iroh.xcframework')
  fs.mkdirSync(framework, { recursive: true })
  fs.mkdirSync(native)
  fs.mkdirSync(path.join(root, 'bin'))
  fs.writeFileSync(path.join(framework, 'Binary'), 'trusted framework')
  fs.writeFileSync(bindings, 'trusted bindings')
  const zipped = spawnSync('zip', ['-qr', archive, 'Iroh'], {
    cwd: path.join(root, 'fixture'),
    encoding: 'utf8'
  })
  expect(zipped.status, zipped.stderr).toBe(0)
  const archiveSha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
  const bindingsSha256 = createHash('sha256').update(fs.readFileSync(bindings)).digest('hex')
  // Only the fixture copy substitutes hashes; the production installer keeps its upstream pins.
  fs.writeFileSync(
    path.join(native, 'install-bindings.sh'),
    installer
      .replace(/^XCFRAMEWORK_SHA256="[a-f0-9]+"/m, `XCFRAMEWORK_SHA256="${archiveSha256}"`)
      .replace(/^BINDINGS_SHA256="[a-f0-9]+"/m, `BINDINGS_SHA256="${bindingsSha256}"`)
  )
  fs.writeFileSync(path.join(native, 'ExpoIroh.podspec'), podspec)
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  fs.writeFileSync(
    path.join(root, 'bin/curl'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOWNLOAD_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) destination="$2"; shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  https://github.com/n0-computer/iroh-ffi/releases/download/v1.1.0/IrohLib.xcframework.zip)
    cp "$FIXTURE_ARCHIVE" "$destination" ;;
  https://raw.githubusercontent.com/n0-computer/iroh-ffi/v1.1.0/IrohLib/Sources/IrohLib/IrohLib.swift)
    cp "$FIXTURE_BINDINGS" "$destination" ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 }
  )
  env = {
    ...process.env,
    PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    FIXTURE_ARCHIVE: archive,
    FIXTURE_BINDINGS: bindings,
    DOWNLOAD_LOG: path.join(root, 'downloads')
  }
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('iOS pinned binding installation', () => {
  it.skipIf(!hasRuby)(
    'installs during local podspec evaluation without running prepare_command',
    () => {
      // A local :path pod evaluates this DSL but CocoaPods does not run prepare_command.
      const result = run('ruby', [
        '-e',
        'module Pod; class Spec; def self.new; yield allocate; end; def method_missing(*); end; end; end; load ARGV.fetch(0)',
        path.join(native, 'ExpoIroh.podspec')
      ])
      expect(result.status, result.stderr).toBe(0)
      expect(fs.readFileSync(path.join(native, 'Vendor/IrohLib.swift'), 'utf8')).toBe(
        'trusted bindings'
      )
      expect(fs.existsSync(path.join(native, 'Vendor/Iroh.xcframework/Binary'))).toBe(true)
    }
  )

  it('reuses checked downloads but replaces altered extracted framework contents', () => {
    install()
    const downloads = fs.readFileSync(env.DOWNLOAD_LOG!, 'utf8')
    expect(downloads.match(/--proto =https --proto-redir =https/g)).toHaveLength(2)
    const framework = path.join(native, 'Vendor/Iroh.xcframework')
    fs.writeFileSync(path.join(framework, 'Binary'), 'tampered')
    fs.writeFileSync(path.join(framework, 'Injected'), 'extra')
    install()
    expect(fs.readFileSync(path.join(framework, 'Binary'), 'utf8')).toBe('trusted framework')
    expect(fs.existsSync(path.join(framework, 'Injected'))).toBe(false)
    expect(fs.readFileSync(env.DOWNLOAD_LOG!, 'utf8')).toBe(downloads)
  })

  it.each(['IrohLib.xcframework.zip', 'IrohLib.swift'])('rejects an altered cached %s', (file) => {
    install()
    fs.appendFileSync(path.join(native, 'Vendor', file), 'tampered')
    const result = run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('checksum mismatch')
  })

  it('does not publish a downloaded archive with the wrong hash', () => {
    fs.appendFileSync(archive, 'tampered')
    const result = run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('checksum mismatch')
    expect(fs.existsSync(path.join(native, 'Vendor/IrohLib.xcframework.zip'))).toBe(false)
    expect(fs.readdirSync(path.join(native, 'Vendor'))).toEqual([])
  })
})
