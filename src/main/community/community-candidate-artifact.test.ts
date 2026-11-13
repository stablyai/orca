import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { CommunityCandidateRun } from '../../shared/community-candidates'
import { stageCommunityCandidateArtifact } from './community-candidate-artifact'

vi.mock('../github/accounts/gh-account-token', () => ({
  resolveGhAccountToken: async () => 'test-account-token'
}))
vi.mock('../network/http-client', () => ({
  getMainHttpClient: () => ({
    fetch: async (url: string, init: RequestInit) => {
      if (url.startsWith('https://api.github.com/')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://artifacts.example.test/candidate.zip' }
        })
      }
      expect(new Headers(init.headers).has('Authorization')).toBe(false)
      return new Response('hello')
    }
  })
}))

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const run: CommunityCandidateRun = {
  plan: {
    id: 'a7c1e0f8-15a8-4077-9427-6630be25899c',
    digest: 'b'.repeat(64),
    createdAt: '2026-11-12T12:00:00.000Z',
    baseSha: 'a'.repeat(40),
    profileMode: null,
    customSource: null,
    includedChanges: [],
    additions: []
  },
  repository: 'example/orca',
  workflowRef: 'main',
  workflowCommit: 'c'.repeat(40),
  source: null,
  artifact: null,
  requestedAt: '2026-11-12T12:00:00.000Z',
  runId: 123,
  state: 'completed',
  conclusion: 'success',
  url: null,
  artifactUrl: null
}
const list = (digest: string) => async () => ({
  artifacts: [
    { id: 456, name: `community-${run.plan.id}`, expired: false, size_in_bytes: 5, digest }
  ]
})

it('stages verified bytes and a durable receipt without forwarding credentials to storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-candidate-artifact-'))
  folders.push(root)
  const receipt = await stageCommunityCandidateArtifact(
    root,
    run,
    'example',
    list('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  )
  expect(await readFile(receipt.path, 'utf8')).toBe('hello')
  expect(receipt.githubDigestMatched).toBe(true)
  expect(JSON.parse(await readFile(`${receipt.path}.json`, 'utf8')).digest).toBe(
    'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
  )
})

it('discards altered bytes instead of leaving a staged candidate or receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-candidate-artifact-'))
  folders.push(root)
  await expect(
    stageCommunityCandidateArtifact(
      root,
      run,
      'example',
      list('sha256:0000000000000000000000000000000000000000000000000000000000000000')
    )
  ).rejects.toThrow()
  expect(await readdir(root)).toEqual([])
})
