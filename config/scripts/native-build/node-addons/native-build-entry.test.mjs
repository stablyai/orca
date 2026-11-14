import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { adoptPackagedNativeBuildEntries } = require('../../../packaged-native-build-entries.cjs')
const roots = []

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop(), { recursive: true, force: true })
  }
})

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-native-entry-'))
  roots.push(root)
  return root
}

describe('adoptPackagedNativeBuildEntries', () => {
  function packagedNodePty(root, dirs) {
    const buildDir = path.join(root, 'node_modules', 'node-pty', 'build')
    for (const [dir, payload] of Object.entries(dirs)) {
      mkdirSync(path.join(buildDir, dir), { recursive: true })
      writeFileSync(path.join(buildDir, dir, 'pty.node'), payload)
    }
    return buildDir
  }

  it('ships the target entry as build/Release and drops every other entry', () => {
    const root = makeRoot()
    const buildDir = packagedNodePty(root, {
      Release: 'pnpm-install-build',
      'orca-napi-darwin-arm64': 'entry-arm64',
      'orca-napi-darwin-x64': 'entry-x64',
      'orca-napi-darwin-arm64.staging-1-x': 'partial'
    })
    adoptPackagedNativeBuildEntries(root, 'darwin', 'x64')
    expect(readFileSync(path.join(buildDir, 'Release', 'pty.node'), 'utf8')).toBe('entry-x64')
    expect(require('node:fs').readdirSync(buildDir)).toEqual(['Release'])
  })
})
