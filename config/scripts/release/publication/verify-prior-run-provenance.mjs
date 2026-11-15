// Lets the automatic draft publisher check a draft from an earlier release-cut run the way publish-release checks
// its own: the draft's assets must equal the manifests that run's builds (and its macOS run) wrote.
// The draft body names the run, but anyone with contents write can edit it. So the run must be a completed
// release-cut.yml run on main whose own release-record artifact, which only that run could write, names this exact
// release id, tag and commit. Pointing the body at any other run fails that check.
import { inflateRawSync } from 'node:zlib'
import {
  assertMacRun,
  hashReleaseAsset,
  parseManifest,
  verifyAssetProvenance
} from './verify-release-asset-provenance.mjs'
import { githubFetch } from './verify-release-required-assets.mjs'

const API = 'https://api.github.com'
const MAX_BYTES = 64 * 1024
export const RUN_MARKER = /<!-- orca-release-run: ([1-9][0-9]{0,19}) -->/g
export const RECORD_SCHEMA = 'orca-release-record/v1'

export function releaseRunMarker(runId) {
  return `\n\n<!-- orca-release-run: ${runId} -->\n`
}

// Why: generated notes quote PR titles and bodies, which anyone can write. A marker copied from them would give every
// draft two markers, and the publisher would skip all of them. "&#58;" renders as ":" but never matches RUN_MARKER.
export function neutralizeRunMarkers(text) {
  return text.replace(/orca-release-run:/gi, 'orca-release-run&#58;')
}

// Strict reader for an artifact zip holding exactly one small manifest.json. Nothing is written to disk, so entry
// names can never escape a directory; any other name, count, method or size is refused.
export function readZipManifest(buf) {
  const fail = () => {
    throw new Error('artifact zip must hold only a small manifest.json')
  }
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd === -1 || buf.length < eocd + 22 || buf.readUInt16LE(eocd + 10) !== 1) {
    fail()
  }
  const cd = buf.readUInt32LE(eocd + 16)
  if (cd + 46 > buf.length || buf.readUInt32LE(cd) !== 0x02014b50) {
    fail()
  }
  const flags = buf.readUInt16LE(cd + 8)
  const method = buf.readUInt16LE(cd + 10)
  const [packed, size] = [buf.readUInt32LE(cd + 20), buf.readUInt32LE(cd + 24)]
  const name = buf.toString('utf8', cd + 46, cd + 46 + buf.readUInt16LE(cd + 28))
  const local = buf.readUInt32LE(cd + 42)
  if (name !== 'manifest.json' || flags & 1 || ![0, 8].includes(method) || size > MAX_BYTES) {
    fail()
  }
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) {
    fail()
  }
  const nameEnd = local + 30 + buf.readUInt16LE(local + 26)
  if (buf.toString('utf8', local + 30, nameEnd) !== name) {
    fail()
  }
  const start = nameEnd + buf.readUInt16LE(local + 28)
  const data = buf.subarray(start, start + packed)
  if (data.length !== packed) {
    fail()
  }
  const out = method === 0 ? data : inflateRawSync(data, { maxOutputLength: MAX_BYTES })
  if (out.length !== size) {
    fail()
  }
  return out.toString('utf8')
}

export function parseRecord(text, { release, runId }) {
  const record = JSON.parse(text)
  const ok =
    JSON.stringify(Object.keys(record ?? {}).sort()) ===
      '["release_id","release_sha","run_id","schema","tag"]' &&
    record.schema === RECORD_SCHEMA &&
    record.release_id === release.id &&
    record.tag === release.tag_name &&
    record.release_sha === release.target_commitish &&
    record.run_id === runId
  if (!ok) {
    throw new Error(`run ${runId} did not create this draft`)
  }
}

export function assertReleaseCutRun(run, { repo, runId }) {
  const ok =
    String(run?.id) === runId &&
    run.path === '.github/workflows/release-cut.yml' &&
    run.head_branch === 'main' &&
    ['schedule', 'workflow_dispatch'].includes(run.event) &&
    run.repository?.full_name === repo &&
    run.head_repository?.full_name === repo &&
    run.status === 'completed'
  if (!ok) {
    throw new Error(`run ${runId} is not a completed release-cut.yml run on main`)
  }
}

// Why the job, not the artifact: anyone with write access can delete a run's artifacts (and the draft's server
// assets), but nobody can change which jobs a finished run ran or how they ended. So the orca-server manifest is
// required exactly when that run's upload job succeeded, and must be absent when it was skipped. Any other state, no
// such job, or an API failure refuses the draft.
async function orcaServerUploadConclusion(get, runId) {
  const jobs = []
  for (let page = 1; page <= 10; page += 1) {
    const body = await get(`/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`)
    const batch = Array.isArray(body?.jobs) ? body.jobs : []
    jobs.push(...batch)
    if (batch.length < 100) {
      break
    }
  }
  const found = jobs.filter((job) => job?.name === 'upload-orca-server-artifact')
  const conclusion = found.length === 1 ? found[0].conclusion : undefined
  if (conclusion !== 'success' && conclusion !== 'skipped') {
    throw new Error(
      `run ${runId} has no single successful or skipped upload-orca-server-artifact job`
    )
  }
  return conclusion
}

export async function verifyPriorRunProvenance({ repo, token, actionsToken, release }) {
  if (!actionsToken) {
    throw new Error('an actions: read token is required to read build manifests')
  }
  const get = async (path, auth = actionsToken) =>
    (await githubFetch(`${API}/repos/${repo}${path}`, auth)).json()
  const markers = [...String(release.body ?? '').matchAll(RUN_MARKER)]
  if (markers.length !== 1) {
    throw new Error('draft does not name the release-cut run that built it')
  }
  const runId = markers[0][1]
  const run = await get(`/actions/runs/${runId}`)
  assertReleaseCutRun(run, { repo, runId })
  const tag = release.tag_name
  const serverUpload = await orcaServerUploadConclusion(get, runId)

  const artifactsNamed = async (fromRunId, name) => {
    const list = await get(`/actions/runs/${fromRunId}/artifacts?name=${name}&per_page=100`)
    return (list.artifacts ?? []).filter((artifact) => artifact.name === name)
  }
  // Each artifact name must exist exactly once, in that run, unexpired and small.
  const download = async (fromRunId, name) => {
    const found = await artifactsNamed(fromRunId, name)
    const [artifact] = found
    if (
      found.length !== 1 ||
      artifact.expired !== false ||
      String(artifact.workflow_run?.id) !== fromRunId ||
      artifact.size_in_bytes > MAX_BYTES
    ) {
      throw new Error(`run ${fromRunId} has no single usable ${name} artifact`)
    }
    const zip = await githubFetch(
      `${API}/repos/${repo}/actions/artifacts/${artifact.id}/zip`,
      actionsToken
    )
    return readZipManifest(Buffer.from(await zip.arrayBuffer()))
  }
  parseRecord(await download(runId, 'release-record'), { release, runId })

  // The macOS run that run dispatched for this tag, found by its run name and checked like publish-release does.
  const since = encodeURIComponent(`>=${run.created_at}`)
  const macRuns = await get(
    `/actions/workflows/release-mac-build.yml/runs?branch=main&event=workflow_dispatch&status=success&created=${since}&per_page=100`
  )
  const title = `Mac release build ${tag} (${runId})`
  const matches = (macRuns.workflow_runs ?? []).filter((r) => r.display_title === title)
  if (matches.length !== 1) {
    throw new Error(`found ${matches.length} successful macOS runs for ${tag}, expected one`)
  }
  const macRunId = String(matches[0].id)
  assertMacRun(matches[0], { repo, tag, releaseRunId: runId, macRunId })

  const common = { tag, release_sha: release.target_commitish }
  const manifests = []
  for (const source of ['linux-x64', 'linux-arm64', 'win', 'orca-server']) {
    const name = `release-asset-manifest-${source}`
    if (source === 'orca-server' && serverUpload === 'skipped') {
      // The release ships without the server tarballs, as publish-release does when the upload job is skipped.
      if ((await artifactsNamed(runId, name)).length !== 0) {
        throw new Error(`run ${runId} skipped upload-orca-server-artifact but has ${name}`)
      }
      continue
    }
    const expected = { ...common, source, run_id: runId, firstAttempt: source === 'win' }
    manifests.push(parseManifest(await download(runId, name), expected))
  }
  const macText = await download(macRunId, 'release-asset-manifest-mac')
  manifests.push(parseManifest(macText, { ...common, source: 'mac', run_id: macRunId }))
  await verifyAssetProvenance({
    tag,
    assets: release.assets ?? [],
    manifests,
    hashAsset: hashReleaseAsset(repo, token)
  })
}
