import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { assertGuestTreeKillBuildFresh, guestTreeKillSourceHash } from './build-guest-tree-kill.mjs'
import { zigAsset, ZIG_ASSETS } from './guest-tree-kill-toolchain.mjs'
import { writeGuestTreeKillArtifactsFixture } from '../../src/shared/guest-tree-kill-artifacts-test-fixture.ts'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-guest-build-'))
  roots.push(root)
  mkdirSync(join(root, 'native', 'linux-guest-tree-kill'), { recursive: true })
  const source = join(root, 'native', 'linux-guest-tree-kill', 'main.c')
  writeFileSync(source, 'int main(void) { return 0; }\n')
  const artifacts = join(root, 'resources', 'guest-tree-kill')
  writeGuestTreeKillArtifactsFixture(artifacts)
  const manifestPath = join(artifacts, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.sourceSha256 = guestTreeKillSourceHash(root)
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return { root, source, artifacts }
}

describe('guest cleanup helper build contract', () => {
  it('pins immutable official compiler archives for all supported build hosts', () => {
    expect(Object.keys(ZIG_ASSETS)).toHaveLength(6)
    for (const target of Object.keys(ZIG_ASSETS)) {
      const [platform, arch] = target.split('-')
      const asset = zigAsset(platform, arch)
      expect(asset.name).toContain('0.16.0')
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(asset.archive).toMatch(platform === 'win32' ? /\.zip$/ : /\.tar\.xz$/)
    }
    expect(() => zigAsset('freebsd', 'x64')).toThrow(/No pinned/)
  })

  it('rejects stale source, absent notices, and corrupted compiled artifacts', () => {
    const { root, source, artifacts } = fixture()
    expect(() => assertGuestTreeKillBuildFresh(artifacts, root)).not.toThrow()
    writeFileSync(source, 'int main(void) { return 1; }\n')
    expect(() => assertGuestTreeKillBuildFresh(artifacts, root)).toThrow(/stale/)
    writeFileSync(source, 'int main(void) { return 0; }\n')
    rmSync(join(artifacts, 'licenses', 'musl-COPYRIGHT'))
    expect(() => assertGuestTreeKillBuildFresh(artifacts, root)).toThrow(/license/)
    writeFileSync(join(artifacts, 'linux-arm64', 'orca-guest-tree-kill'), 'broken')
    expect(() => assertGuestTreeKillBuildFresh(artifacts, root)).toThrow(/digest/)
  })

  it('ignores C test changes while tracking included production headers', () => {
    const { root } = fixture()
    const before = guestTreeKillSourceHash(root)
    writeFileSync(join(root, 'native/linux-guest-tree-kill/main.test.c'), 'a test')
    expect(guestTreeKillSourceHash(root)).toBe(before)
    writeFileSync(join(root, 'native/linux-guest-tree-kill/limits.h'), '#define LIMIT 1')
    expect(guestTreeKillSourceHash(root)).not.toBe(before)
  })

  it('keeps native execution coverage on both Linux guest architectures without privileged setup', () => {
    const workflow = parse(readFileSync('.github/workflows/guest-tree-kill-native.yml', 'utf8'))
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs.native.strategy.matrix.include.map((row) => row.arch)).toEqual([
      'x64',
      'arm64'
    ])
    const test = workflow.jobs.native.steps.find(
      (step) => step.name === 'Execute the packaged native-host helper'
    )
    expect(test.env.ORCA_GUEST_TREE_KILL_TEST_BINARY).toContain(
      'resources/guest-tree-kill/linux-${{ matrix.arch }}'
    )
    expect(test.run).toContain('wsl-guest-tree-kill-native.test.ts')
    expect(test.run).not.toContain('wsl-guest-tree-kill-script.test.ts')
  })

  it('prepares Windows development and build entry points before launch', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
    for (const name of ['dev', 'dev-stable-name']) {
      expect(scripts[name]).toContain('build-guest-tree-kill.mjs --windows-only')
    }
    expect(scripts['build:win']).toContain('build:guest-tree-kill')
    const native = readFileSync('config/scripts/build-native-for-platform.mjs', 'utf8')
    expect(native).toContain("runNodeScript('config/scripts/build-guest-tree-kill.mjs')")
  })
})
