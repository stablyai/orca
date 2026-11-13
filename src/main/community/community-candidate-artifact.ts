import type { CommunityFeatureStore } from './community-feature-store'
import { communityCandidateRunSchema as runSchema } from './community-candidate-record'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { getMainHttpClient } from '../network/http-client'
import { resolveGhAccountToken } from '../github/accounts/gh-account-token'
import type {
  CommunityCandidateRun,
  CommunityArtifactReceipt
} from '../../shared/community-candidates'
import { writeCommunityJson } from './community-json-file'
const artifact = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  expired: z.boolean(),
  size_in_bytes: z.number().nonnegative(),
  digest: z.string().nullable().optional()
})
const MAX_BYTES = 1024 * 1024 * 1024
export async function stageCommunityCandidateArtifact(
  root: string,
  run: CommunityCandidateRun,
  user: string,
  api: (path: string) => Promise<unknown>
): Promise<CommunityArtifactReceipt> {
  if (!run.runId || run.state !== 'completed') {
    throw new Error('Wait for this candidate run to finish before staging its evidence.')
  }
  const list = z
    .object({ artifacts: z.array(artifact).max(100) })
    .parse(await api(`repos/${run.repository}/actions/runs/${run.runId}/artifacts?per_page=100`))
  const selected = list.artifacts.find(
    (row) => row.name === `community-${run.plan.id}` && !row.expired
  )
  if (!selected) {
    throw new Error(
      'This run has no available candidate artifact. Check its logs or prepare a new run.'
    )
  }
  if (selected.size_in_bytes > MAX_BYTES) {
    throw new Error('This artifact exceeds the 1 GiB staging limit.')
  }
  const token = await resolveGhAccountToken({ host: 'github.com', user })
  const client = getMainHttpClient()
  const url = `https://api.github.com/repos/${run.repository}/actions/artifacts/${selected.id}/zip`
  const first = await client.fetch(url, {
    credentials: 'omit',
    redirect: 'manual',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000)
  })
  let response = first
  if (first.status === 302) {
    const location = first.headers.get('location')
    await first.body?.cancel()
    if (!location) {
      throw new Error('GitHub did not provide an artifact download location.')
    }
    const target = new URL(location)
    if (target.protocol !== 'https:' || target.username || target.password) {
      throw new Error('GitHub returned an invalid artifact location.')
    }
    response = await client.fetch(target.href, {
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(300_000)
    })
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`Artifact download failed (HTTP ${response.status}).`)
  }
  await mkdir(root, { recursive: true, mode: 0o700 })
  const name = `${run.plan.id}-${selected.id}.zip`
  const temporary = join(root, `${name}.${randomUUID()}.tmp`)
  const destination = join(root, name)
  const file = await open(temporary, 'wx', 0o600)
  const hash = createHash('sha256')
  let closed = false
  let bytes = 0
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength
      if (bytes > MAX_BYTES) {
        throw new Error('Artifact download exceeded the 1 GiB staging limit.')
      }
      hash.update(chunk)
      await file.writeFile(chunk)
    }
    const digest = `sha256:${hash.digest('hex')}`
    if (selected.digest && selected.digest !== digest) {
      throw new Error('The downloaded bytes do not match GitHub’s artifact digest.')
    }
    await file.close()
    closed = true
    await rename(temporary, destination)
    const receipt: CommunityArtifactReceipt = {
      artifactId: selected.id,
      name,
      path: destination,
      bytes,
      digest,
      githubDigestMatched: !!selected.digest,
      stagedAt: new Date().toISOString(),
      sourceUrl: `https://github.com/${run.repository}/actions/runs/${run.runId}/artifacts/${selected.id}`
    }
    await writeCommunityJson(join(root, `${name}.json`), receipt, true)
    return receipt
  } finally {
    if (!closed) {
      await file.close()
    }
    await response.body?.cancel().catch(() => {})
    await rm(temporary, { force: true })
  }
}

export async function stageCommunityCandidateRun(
  root: string,
  id: string,
  user: string | null,
  api: (path: string) => Promise<unknown>,
  features: CommunityFeatureStore
): Promise<CommunityArtifactReceipt> {
  if (!user) {
    throw new Error('Choose a GitHub account before downloading candidate artifacts.')
  }
  const path = join(root, `${id}-run.json`)
  const run = runSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  const artifact = await stageCommunityCandidateArtifact(join(root, 'staged'), run, user, api)
  const current = runSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  await writeCommunityJson(path, { ...current, artifact }, true)
  for (const addition of run.plan.additions) {
    await features.recordCandidate(
      addition.number,
      { id, state: 'artifact-staged', url: artifact.sourceUrl, headSha: addition.headSha },
      [artifact.digest]
    )
  }
  return artifact
}
