import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import {
  MobileWebManifestSchema,
  serializeMobileWebManifestForBuildId
} from '../../src/shared/mobile-web/manifest-contract.ts'
import {
  createHostedIosOtaPackageFixture,
  serveHostedIosOtaGeneration
} from './hosted-ios-ota-package-fixture.mjs'
import { fingerprintHostedIosOtaShell } from './hosted-ios-ota-shell-fingerprint.mjs'
import { parseHostedWebViewSimulatorE2eOptions } from './hosted-webview-simulator-e2e-options.mjs'

const roots = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orca-ota-fixture-test-'))
  roots.push(root)
  return root
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
async function sourceFixture(root) {
  const sourceRoot = path.join(root, 'source')
  const document = Buffer.from('<html><head><title>Orca</title></head><body>Settings</body></html>')
  const seed = {
    schemaVersion: 1,
    buildId: '0'.repeat(64),
    bridge: { minimum: 2, testedThrough: 2 },
    entrypoint: 'index.html',
    totalBytes: document.length,
    assets: [
      {
        path: 'index.html',
        sha256: sha256(document),
        byteLength: document.length,
        contentType: 'text/html; charset=utf-8',
        role: 'document'
      }
    ]
  }
  const manifest = { ...seed, buildId: sha256(serializeMobileWebManifestForBuildId(seed)) }
  await mkdir(sourceRoot)
  await writeFile(path.join(sourceRoot, 'index.html'), document)
  await writeFile(path.join(sourceRoot, 'manifest.json'), JSON.stringify(manifest))
  return { sourceRoot, document, manifest }
}

test('creates independently verifiable A/B pages and atomically changes only Desktop delivery', async () => {
  const root = await temporaryRoot()
  const source = await sourceFixture(root)
  const fixture = await createHostedIosOtaPackageFixture({
    sourceRoot: source.sourceRoot,
    runtimeDirectory: root
  })
  assert.notEqual(fixture.A.buildId, fixture.B.buildId)
  assert.notEqual(fixture.A.buildId, source.manifest.buildId)
  for (const generation of [fixture.A, fixture.B]) {
    const manifest = MobileWebManifestSchema.parse(
      JSON.parse(await readFile(path.join(generation.directory, 'manifest.json'), 'utf8'))
    )
    assert.equal(sha256(serializeMobileWebManifestForBuildId(manifest)), manifest.buildId)
    for (const asset of manifest.assets) {
      const bytes = await readFile(path.join(generation.directory, asset.path))
      assert.equal(sha256(bytes), asset.sha256)
      assert.equal(bytes.length, asset.byteLength)
    }
    assert.ok(
      (await readFile(path.join(generation.directory, 'index.html'), 'utf8')).includes(
        `content="${generation.marker}"`
      )
    )
  }
  const servedBuild = async () =>
    JSON.parse(await readFile(path.join(fixture.servedPackagePath, 'manifest.json'), 'utf8'))
      .buildId
  assert.equal(await servedBuild(), fixture.A.buildId)
  await serveHostedIosOtaGeneration(fixture, 'B')
  assert.equal(await servedBuild(), fixture.B.buildId)
  assert.deepEqual(await readFile(path.join(source.sourceRoot, 'index.html')), source.document)
})

test('refuses an unverified source package', async () => {
  const root = await temporaryRoot()
  const source = await sourceFixture(root)
  await writeFile(path.join(source.sourceRoot, 'index.html'), 'changed')
  await assert.rejects(
    createHostedIosOtaPackageFixture({ sourceRoot: source.sourceRoot, runtimeDirectory: root }),
    /source asset is invalid/
  )
})

test('detects changed native bytes and shell source independently', async () => {
  const worktree = await temporaryRoot()
  const sourceRoots = [
    'mobile/app',
    'mobile/src',
    'mobile/packages',
    'src/shared',
    'src/mobile-web/src'
  ]
  for (const directory of sourceRoots) {
    await mkdir(path.join(worktree, directory), { recursive: true })
  }
  const nativeAppPath = path.join(worktree, 'Orca.app')
  await mkdir(nativeAppPath)
  await writeFile(path.join(nativeAppPath, 'Orca'), 'native A')
  const args = { worktree, nativeAppPath }
  const before = await fingerprintHostedIosOtaShell(args)
  await writeFile(path.join(nativeAppPath, 'Orca'), 'native B')
  const nativeChanged = await fingerprintHostedIosOtaShell(args)
  assert.notEqual(before.native.sha256, nativeChanged.native.sha256)
  assert.equal(before.source.sha256, nativeChanged.source.sha256)
  await writeFile(path.join(worktree, 'mobile/app/hybrid.tsx'), 'changed shell')
  const sourceChanged = await fingerprintHostedIosOtaShell(args)
  assert.notEqual(nativeChanged.source.sha256, sourceChanged.source.sha256)
})

test('adds an exclusive OTA mode without changing existing option defaults', () => {
  assert.equal(parseHostedWebViewSimulatorE2eOptions([]).otaOnly, undefined)
  assert.equal(
    parseHostedWebViewSimulatorE2eOptions(['--ota-only', '--reuse-native-install']).otaOnly,
    true
  )
  assert.throws(
    () => parseHostedWebViewSimulatorE2eOptions(['--ota-only', '--adversarial-content']),
    /mutually exclusive/
  )
})
