import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertMacRun,
  parseManifest,
  readManifestDir,
  readRunManifests,
  verifyAssetProvenance
} from './verify-release-asset-provenance.mjs'
import { getRequiredReleaseAssetNames } from './verify-release-required-assets.mjs'
import { MANIFEST_SCHEMA } from './write-release-asset-manifest.mjs'

const TAG = 'v1.2.3'
const SHA = 'a'.repeat(40)
const sha = (name) => createHash('sha256').update(name).digest('hex')
const entry = (name) => ({ name, size: name.length, sha256: sha(name) })
const draftAsset = (name, overrides = {}) => ({
  id: name.length,
  name,
  size: name.length,
  state: 'uploaded',
  digest: `sha256:${sha(name)}`,
  ...overrides
})
const required = getRequiredReleaseAssetNames(TAG)
const manifest = (source, names, overrides = {}) => ({
  schema: MANIFEST_SCHEMA,
  source,
  tag: TAG,
  release_sha: SHA,
  run_id: '100',
  run_attempt: '1',
  assets: names.map(entry),
  ...overrides
})
// The required assets split across two manifests, plus the source map zip.
const manifests = () => [
  manifest('linux-x64', [...required.slice(0, 10), `orca-sourcemaps-${TAG}.zip`]),
  manifest('mac', required.slice(10), { run_id: '200' })
]
const allNames = [...required, `orca-sourcemaps-${TAG}.zip`]
const verify = (assets, list = manifests(), hashAsset = vi.fn()) =>
  verifyAssetProvenance({ tag: TAG, assets, manifests: list, hashAsset })

describe('verifyAssetProvenance', () => {
  it('accepts a draft that equals the manifests combined', async () => {
    await expect(verify(allNames.map((name) => draftAsset(name)))).resolves.toEqual(
      [...allNames].sort()
    )
  })

  it('refuses an asset whose bytes were replaced after upload', async () => {
    const assets = allNames.map((name) =>
      draftAsset(name, name === 'latest.yml' ? { digest: `sha256:${sha('evil')}` } : {})
    )
    await expect(verify(assets)).rejects.toThrow(/latest.yml digest .* does not match/)
  })

  it('refuses a size or upload-state mismatch', async () => {
    const assets = allNames.map((name) =>
      draftAsset(name, name === 'latest.yml' ? { state: 'starter' } : {})
    )
    await expect(verify(assets)).rejects.toThrow(/latest.yml is starter/)
  })

  it('refuses an extra asset no build recorded', async () => {
    const assets = [...allNames, 'payload.sh'].map((name) => draftAsset(name))
    await expect(verify(assets)).rejects.toThrow(/payload.sh is not in any build manifest/)
  })

  it('refuses a recorded or required asset missing from the draft', async () => {
    const assets = allNames
      .filter((name) => !name.startsWith('orca-sourcemaps'))
      .map((n) => draftAsset(n))
    await expect(verify(assets)).rejects.toThrow(/orca-sourcemaps-v1.2.3.zip is missing/)
    const unrecorded = [manifest('linux-x64', ['latest.yml'])]
    await expect(verify([draftAsset('latest.yml')], unrecorded)).rejects.toThrow(
      /latest-mac.yml is missing/
    )
  })

  it('refuses a name claimed by two manifests or listed twice on the draft', async () => {
    const list = [...manifests(), manifest('win', ['latest.yml'])]
    await expect(
      verify(
        allNames.map((name) => draftAsset(name)),
        list
      )
    ).rejects.toThrow(/duplicate manifest entry latest.yml/)
    const assets = [...allNames, 'latest.yml'].map((name) => draftAsset(name))
    await expect(verify(assets)).rejects.toThrow(/duplicate draft asset latest.yml/)
  })

  it('hashes the downloaded bytes when GitHub reports no digest', async () => {
    const assets = allNames.map((name) =>
      draftAsset(name, name === 'latest.yml' ? { digest: null } : {})
    )
    const hashAsset = vi.fn(async (asset) => sha(asset.name))
    await expect(verify(assets, manifests(), hashAsset)).resolves.toHaveLength(allNames.length)
    expect(hashAsset).toHaveBeenCalledTimes(1)
    await expect(verify(assets, manifests(), async () => sha('evil'))).rejects.toThrow(
      /latest.yml digest/
    )
  })
})

describe('parseManifest', () => {
  const expected = { source: 'win', tag: TAG, release_sha: SHA, run_id: '100', firstAttempt: true }
  const parse = (value) => parseManifest(JSON.stringify(value), expected)

  it('accepts the manifest the writer produces', () => {
    expect(parse(manifest('win', ['latest.yml'])).assets).toEqual([entry('latest.yml')])
  })

  it.each([
    ['another tag', { tag: 'v9.9.9' }],
    ['another release commit', { release_sha: 'b'.repeat(40) }],
    ['another run', { run_id: '101' }],
    ['another source', { source: 'linux-x64' }],
    ['another schema', { schema: 'v0' }],
    ['a later attempt for Windows', { run_attempt: '2' }],
    ['an extra field', { note: 'x' }],
    ['no assets', { assets: [] }],
    ['a path in a name', { assets: [{ ...entry('a'), name: '../latest.yml' }] }],
    ['a nested name', { assets: [{ ...entry('a'), name: 'dist/latest.yml' }] }],
    ['a non-string name', { assets: [{ ...entry('a'), name: ['latest.yml'] }] }],
    ['a short digest', { assets: [{ ...entry('a'), sha256: 'abc' }] }],
    ['an extra asset field', { assets: [{ ...entry('a'), url: 'x' }] }]
  ])('refuses %s', (_name, overrides) => {
    expect(() => parse(manifest('win', ['latest.yml'], overrides))).toThrow()
  })

  it('requires the mac manifest to come from the qualified attempt', () => {
    const mac = { ...expected, source: 'mac', firstAttempt: false, runAttempt: '2' }
    const at = (attempt) =>
      JSON.stringify(manifest('mac', ['latest-mac.yml'], { source: 'mac', run_attempt: attempt }))
    expect(() => parseManifest(at('2'), mac)).not.toThrow()
    expect(() => parseManifest(at('3'), mac)).toThrow(/run_attempt '3'/)
    expect(() => parseManifest(at('1'), mac)).toThrow(/run_attempt '1'/)
  })

  it('accepts a later attempt for jobs that rerun their uploads', () => {
    const value = manifest('linux-x64', ['latest-linux.yml'], { run_attempt: '2' })
    expect(() =>
      parseManifest(JSON.stringify(value), {
        ...expected,
        source: 'linux-x64',
        firstAttempt: false
      })
    ).not.toThrow()
  })
})

describe('manifest artifact layout', () => {
  let dir
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))
  const artifact = (name, files = { 'manifest.json': '{}' }) => {
    mkdirSync(join(dir, name), { recursive: true })
    for (const [file, body] of Object.entries(files)) {
      writeFileSync(join(dir, name, file), body)
    }
  }

  it('reads exactly one manifest per expected artifact', () => {
    dir = mkdtempSync(join(tmpdir(), 'asset-provenance-'))
    artifact('release-asset-manifest-win')
    artifact('release-asset-manifest-linux-x64')
    expect([...readRunManifests(dir, ['win', 'linux-x64']).keys()].sort()).toEqual([
      'linux-x64',
      'win'
    ])
    expect(() => readRunManifests(dir, ['win', 'linux-x64', 'linux-arm64'])).toThrow(
      /Missing release asset manifests: linux-arm64/
    )
    artifact('release-asset-manifest-evil')
    expect(() => readRunManifests(dir, ['win', 'linux-x64'])).toThrow(/Unexpected manifest/)
  })

  it.skipIf(process.platform === 'win32')(
    'refuses links, nested paths and extra files inside an artifact',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'asset-provenance-'))
      writeFileSync(join(dir, 'outside.json'), '{}')
      mkdirSync(join(dir, 'link'))
      symlinkSync(join(dir, 'outside.json'), join(dir, 'link', 'manifest.json'))
      expect(() => readManifestDir(join(dir, 'link'))).toThrow(/regular manifest.json/)
      artifact('extra', { 'manifest.json': '{}', 'other.json': '{}' })
      expect(() => readManifestDir(join(dir, 'extra'))).toThrow()
      mkdirSync(join(dir, 'nested', 'manifest.json'), { recursive: true })
      expect(() => readManifestDir(join(dir, 'nested'))).toThrow()
      artifact('big', { 'manifest.json': 'x'.repeat(70 * 1024) })
      expect(() => readManifestDir(join(dir, 'big'))).toThrow()
      symlinkSync(join(dir, 'extra'), join(dir, 'release-asset-manifest-win'))
      expect(() => readRunManifests(dir, ['win'])).toThrow(/Unexpected manifest/)
    }
  )
})

describe('assertMacRun', () => {
  const repo = 'stablyai/orca'
  const run = {
    id: 200,
    path: '.github/workflows/release-mac-build.yml',
    head_branch: 'main',
    event: 'workflow_dispatch',
    repository: { full_name: repo },
    head_repository: { full_name: repo },
    status: 'completed',
    conclusion: 'success',
    display_title: `Mac release build ${TAG} (100)`,
    run_attempt: 2
  }
  const check = (overrides, macRunAttempt = '2') =>
    assertMacRun(
      { ...run, ...overrides },
      { repo, tag: TAG, releaseRunId: '100', macRunId: '200', macRunAttempt }
    )

  it('accepts the release-mac-build run this release dispatched', () => {
    expect(() => check({})).not.toThrow()
  })

  it.each(['@main', '@refs/heads/main'])('accepts its path qualified with %s', (suffix) => {
    expect(() => check({ path: `${run.path}${suffix}` })).not.toThrow()
  })

  it.each([
    ['another workflow', { path: '.github/workflows/adhoc-mac-build.yml' }],
    [
      'its path qualified with another ref',
      { path: '.github/workflows/release-mac-build.yml@feature' }
    ],
    ['its path qualified twice', { path: '.github/workflows/release-mac-build.yml@main@main' }],
    ['another branch', { head_branch: 'feature' }],
    ['another release run', { display_title: `Mac release build ${TAG} (101)` }],
    ['another tag', { display_title: 'Mac release build v1.2.4 (100)' }],
    ['a failed run', { conclusion: 'failure' }],
    ['a fork', { head_repository: { full_name: 'mallory/orca' } }],
    ['another run id', { id: 201 }],
    ['a later attempt than the qualified one', { run_attempt: 3 }],
    ['an earlier attempt than the qualified one', { run_attempt: 1 }]
  ])('refuses %s', (_name, overrides) => {
    expect(() => check(overrides)).toThrow(/not the successful release-mac-build.yml run/)
  })

  it('refuses without a qualified attempt', () => {
    expect(() => check({}, null)).toThrow(/not the successful release-mac-build.yml run/)
    expect(() => check({}, '')).toThrow(/not the successful release-mac-build.yml run/)
  })
})
