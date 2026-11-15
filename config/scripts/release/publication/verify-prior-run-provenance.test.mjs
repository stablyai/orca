import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertReleaseCutRun,
  parseRecord,
  readZipManifest,
  RECORD_SCHEMA,
  releaseRunMarker,
  verifyPriorRunProvenance
} from './verify-prior-run-provenance.mjs'
import { getRequiredReleaseAssetNames } from './verify-release-required-assets.mjs'
import { MANIFEST_SCHEMA } from './write-release-asset-manifest.mjs'

// Minimal zip writer for fixtures: one local header per entry, a central directory, and the end record.
function zip(entries, { method = 8, flags = 0, size } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of entries) {
    const raw = Buffer.from(text)
    const data = method === 8 ? deflateRawSync(raw) : raw
    const nameBuf = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(size ?? raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(size ?? raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

describe('readZipManifest', () => {
  it('reads one deflated or stored manifest.json', () => {
    expect(readZipManifest(zip([['manifest.json', '{"a":1}']]))).toBe('{"a":1}')
    expect(readZipManifest(zip([['manifest.json', '{}']], { method: 0 }))).toBe('{}')
  })

  it.each([
    ['a traversal name', [['../manifest.json', '{}']], {}],
    ['a nested name', [['dir/manifest.json', '{}']], {}],
    [
      'a second entry',
      [
        ['manifest.json', '{}'],
        ['other.json', '{}']
      ],
      {}
    ],
    ['an encrypted entry', [['manifest.json', '{}']], { flags: 1 }],
    ['another method', [['manifest.json', '{}']], { method: 12 }],
    ['an oversized entry', [['manifest.json', 'x'.repeat(70 * 1024)]], {}],
    ['a size that does not match', [['manifest.json', '{}']], { size: 5 }]
  ])('refuses %s', (_name, entries, options) => {
    expect(() => readZipManifest(zip(entries, options))).toThrow()
  })

  it('refuses a buffer that is not a zip', () => {
    expect(() => readZipManifest(Buffer.from('not a zip'))).toThrow()
  })
})

const repo = 'stablyai/orca'
const TAG = 'v1.4.3-rc.1'
const SHA = 'b'.repeat(40)
const required = getRequiredReleaseAssetNames(TAG)
const sha = (name) => createHash('sha256').update(name).digest('hex')
const release = {
  id: 77,
  tag_name: TAG,
  target_commitish: SHA,
  body: `notes${releaseRunMarker('500')}`,
  assets: required.map((name, id) => ({
    id,
    name,
    size: name.length,
    state: 'uploaded',
    digest: `sha256:${sha(name)}`
  }))
}
const record = { schema: RECORD_SCHEMA, tag: TAG, release_id: 77, release_sha: SHA, run_id: '500' }
const cutRun = {
  id: 500,
  path: '.github/workflows/release-cut.yml',
  head_branch: 'main',
  event: 'schedule',
  repository: { full_name: repo },
  head_repository: { full_name: repo },
  status: 'completed',
  created_at: '2026-11-14T11:00:00Z'
}
const macRun = {
  ...cutRun,
  id: 600,
  path: '.github/workflows/release-mac-build.yml',
  event: 'workflow_dispatch',
  conclusion: 'success',
  display_title: `Mac release build ${TAG} (500)`
}
// Linux x64 gets the first six required names, Linux arm64 the next four, Windows two, mac the rest.
const split = { 'linux-x64': [0, 6], 'linux-arm64': [6, 10], win: [10, 12], mac: [12, 20] }
const manifestFor = (source, runId = '500', overrides = {}) =>
  JSON.stringify({
    schema: MANIFEST_SCHEMA,
    source,
    tag: TAG,
    release_sha: SHA,
    run_id: runId,
    run_attempt: '1',
    assets: required
      .slice(...split[source])
      .map((name) => ({ name, size: name.length, sha256: sha(name) })),
    ...overrides
  })

const serverJob = (conclusion) => ({ name: 'upload-orca-server-artifact', conclusion })
const SERVER_ASSETS = [
  'orca-server-linux-x64.tar.gz',
  'orca-server-linux-arm64.tar.gz',
  'orca-server-sha256sums.txt'
]
const serverAsset = (name, id) => ({
  id: 100 + id,
  name,
  size: name.length,
  state: 'uploaded',
  digest: `sha256:${sha(name)}`
})
const withServer = { ...release, assets: [...release.assets, ...SERVER_ASSETS.map(serverAsset)] }
const serverManifest = JSON.stringify({
  schema: MANIFEST_SCHEMA,
  source: 'orca-server',
  tag: TAG,
  release_sha: SHA,
  run_id: '500',
  run_attempt: '1',
  assets: SERVER_ASSETS.map((name) => ({ name, size: name.length, sha256: sha(name) }))
})

function stubGithub({
  run = cutRun,
  macRuns = [macRun],
  artifacts = {},
  recordText = JSON.stringify(record),
  jobs = [{ name: 'build (win)', conclusion: 'success' }, serverJob('skipped')],
  jobsStatus = 200
} = {}) {
  const files = {
    'release-record': recordText,
    'release-asset-manifest-linux-x64': manifestFor('linux-x64'),
    'release-asset-manifest-linux-arm64': manifestFor('linux-arm64'),
    'release-asset-manifest-win': manifestFor('win'),
    'release-asset-manifest-mac': manifestFor('mac', '600'),
    ...artifacts
  }
  const ids = Object.keys(files)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const path = new URL(url).pathname
      const query = new URL(url).searchParams
      const json = (body) => ({ ok: true, json: async () => body })
      if (path === `/repos/${repo}/actions/runs/500`) {
        return json(run)
      }
      if (path === `/repos/${repo}/actions/runs/500/jobs`) {
        expect(query.get('filter')).toBe('latest')
        if (jobsStatus !== 200) {
          throw new Error(`GitHub request failed ${jobsStatus}`)
        }
        return json({ total_count: jobs.length, jobs })
      }
      if (path.endsWith('/workflows/release-mac-build.yml/runs')) {
        return json({ workflow_runs: macRuns })
      }
      const runArtifacts = path.match(/\/actions\/runs\/(\d+)\/artifacts$/)
      if (runArtifacts) {
        const name = query.get('name')
        const inRun = name === 'release-asset-manifest-mac' ? '600' : '500'
        if (files[name] == null || runArtifacts[1] !== inRun) {
          return json({ artifacts: [] })
        }
        const artifact = {
          id: ids.indexOf(name),
          name,
          expired: false,
          size_in_bytes: 100,
          workflow_run: { id: Number(inRun) }
        }
        return json({ artifacts: [artifact] })
      }
      const zipped = path.match(/\/actions\/artifacts\/(\d+)\/zip$/)
      if (zipped) {
        const body = zip([['manifest.json', files[ids[Number(zipped[1])]]]])
        return { ok: true, arrayBuffer: async () => body }
      }
      throw new Error(`Unexpected request ${url}`)
    })
  )
}

const verify = (draft = release) =>
  verifyPriorRunProvenance({ repo, token: 'app', actionsToken: 'actions', release: draft })

describe('verifyPriorRunProvenance', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('accepts a draft whose assets match the manifests of the run that made it', async () => {
    stubGithub()
    await expect(verify()).resolves.toBeUndefined()
  })

  it('refuses a draft with no run marker or two of them', async () => {
    stubGithub()
    await expect(verify({ ...release, body: 'notes' })).rejects.toThrow(/does not name/)
    const twice = `${release.body}${releaseRunMarker('501')}`
    await expect(verify({ ...release, body: twice })).rejects.toThrow(/does not name/)
  })

  it('refuses a body pointed at a run whose record names another release', async () => {
    stubGithub({ recordText: JSON.stringify({ ...record, release_id: 78 }) })
    await expect(verify()).rejects.toThrow(/did not create this draft/)
  })

  it('refuses a run that is not a completed release-cut run on main', async () => {
    stubGithub({ run: { ...cutRun, head_branch: 'feature' } })
    await expect(verify()).rejects.toThrow(/not a completed release-cut.yml run/)
  })

  it('refuses when the macOS run is missing, ambiguous or another run', async () => {
    stubGithub({ macRuns: [] })
    await expect(verify()).rejects.toThrow(/found 0 successful macOS runs/)
    stubGithub({ macRuns: [macRun, { ...macRun, id: 601 }] })
    await expect(verify()).rejects.toThrow(/found 2/)
    stubGithub({ macRuns: [{ ...macRun, path: '.github/workflows/other.yml' }] })
    await expect(verify()).rejects.toThrow(/not the successful release-mac-build.yml run/)
  })

  it('refuses a missing manifest, a later Windows attempt, or a swapped asset', async () => {
    stubGithub({ artifacts: { 'release-asset-manifest-win': null } })
    await expect(verify()).rejects.toThrow(/no single usable release-asset-manifest-win/)
    const later = manifestFor('win', '500', { run_attempt: '2' })
    stubGithub({ artifacts: { 'release-asset-manifest-win': later } })
    await expect(verify()).rejects.toThrow(/run_attempt/)
    stubGithub()
    const swapped = release.assets.map((asset, index) =>
      index === 0 ? { ...asset, digest: `sha256:${sha('evil')}` } : asset
    )
    await expect(verify({ ...release, assets: swapped })).rejects.toThrow(/does not match/)
  })
})

describe('orca-server manifest expectation', () => {
  afterEach(() => vi.unstubAllGlobals())
  const server = { 'release-asset-manifest-orca-server': serverManifest }

  it('requires the server manifest and assets when the upload job succeeded', async () => {
    stubGithub({ jobs: [serverJob('success')], artifacts: server })
    await expect(verify(withServer)).resolves.toBeUndefined()
    // Deleting the manifest artifact and the three draft assets does not drop the requirement.
    stubGithub({ jobs: [serverJob('success')] })
    await expect(verify(release)).rejects.toThrow(
      /no single usable release-asset-manifest-orca-server/
    )
    stubGithub({ jobs: [serverJob('success')], artifacts: server })
    await expect(verify(release)).rejects.toThrow(/orca-server/)
  })

  it('requires no server manifest when the upload job was skipped', async () => {
    stubGithub({ jobs: [serverJob('skipped')] })
    await expect(verify(release)).resolves.toBeUndefined()
    stubGithub({ jobs: [serverJob('skipped')], artifacts: server })
    await expect(verify(withServer)).rejects.toThrow(/skipped upload-orca-server-artifact but has/)
    stubGithub({ jobs: [serverJob('skipped')] })
    await expect(verify(withServer)).rejects.toThrow()
  })

  it.each([
    ['no upload job', []],
    ['a failed upload job', [serverJob('failure')]],
    ['a cancelled upload job', [serverJob('cancelled')]],
    ['two upload jobs', [serverJob('success'), serverJob('success')]]
  ])('refuses %s', async (_name, jobs) => {
    stubGithub({ jobs, artifacts: server })
    await expect(verify(withServer)).rejects.toThrow(/upload-orca-server-artifact job/)
  })

  it('refuses when the jobs API fails', async () => {
    stubGithub({ jobsStatus: 500, artifacts: server })
    await expect(verify(withServer)).rejects.toThrow(/500/)
  })
})

describe('parseRecord and assertReleaseCutRun', () => {
  it.each([
    ['another tag', { tag: 'v1.4.3-rc.2' }],
    ['another commit', { release_sha: 'c'.repeat(40) }],
    ['another run', { run_id: '501' }],
    ['a string release id', { release_id: '77' }],
    ['an extra field', { note: 'x' }]
  ])('refuses a record with %s', (_name, overrides) => {
    expect(() =>
      parseRecord(JSON.stringify({ ...record, ...overrides }), { release, runId: '500' })
    ).toThrow()
  })

  it('refuses a run still in progress or from a fork', () => {
    expect(() =>
      assertReleaseCutRun({ ...cutRun, status: 'in_progress' }, { repo, runId: '500' })
    ).toThrow()
    const fork = { ...cutRun, head_repository: { full_name: 'mallory/orca' } }
    expect(() => assertReleaseCutRun(fork, { repo, runId: '500' })).toThrow()
  })
})
