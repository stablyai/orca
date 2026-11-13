import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CommunityFeatureStore } from './community-feature-store'
import { CommunityEvidenceStore } from './community-evidence-store'
const roots: string[] = []
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'orca-community-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const first = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const second = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const source = {
  number: 42,
  title: 'Keep image responses together',
  headSha: first,
  state: 'open' as const,
  observedAt: '2026-11-12T10:00:00.000Z',
  imageUrls: []
}

it('retains saves, old reading position, and conversation after a source update and restart', async () => {
  const path = await root()
  const store = new CommunityFeatureStore(path, () => new Date('2026-11-12T10:00:00.000Z'))
  await store.observe(source)
  await store.mutate({ action: 'save', number: 42 })
  await store.mutate({ action: 'visit', number: 42, headSha: first })
  await store.mutate({
    action: 'link-chat',
    number: 42,
    chat: {
      headSha: first,
      sessionId: 'session-1',
      tabId: 'agent-session:session-1',
      workspaceId: 'folder-workspace',
      environmentId: 'paired-host',
      agent: 'codex'
    }
  })
  await store.observe({ ...source, headSha: second, observedAt: '2026-11-12T11:00:00.000Z' })
  const restored = await new CommunityFeatureStore(path).read()
  expect(restored.features['42']).toMatchObject({
    savedAt: '2026-11-12T10:00:00.000Z',
    visit: { headSha: first },
    source: { headSha: second },
    chat: { sessionId: 'session-1', environmentId: 'paired-host', headSha: first }
  })
})
it('serializes simultaneous saves without losing an earlier feature', async () => {
  const store = new CommunityFeatureStore(await root())
  await Promise.all([
    store.mutate({ action: 'save', number: 41 }),
    store.mutate({ action: 'select', number: 42 })
  ])
  const state = await store.read()
  expect(state.features['41'].savedAt).not.toBeNull()
  expect(state.features['42'].selectedAt).not.toBeNull()
})
it('keeps the earlier source evidence and conversation after removing a selection', async () => {
  const store = new CommunityFeatureStore(await root())
  await store.observe(source)
  await store.mutate({ action: 'select', number: 42 })
  await store.mutate({ action: 'unselect', number: 42 })
  expect((await store.read()).features['42']).toMatchObject({
    selectedAt: null,
    source: { headSha: first }
  })
  expect((await store.history(42)).events.map((event) => event.kind)).toEqual([
    'unselect',
    'select',
    'source-observed'
  ])
})
it('does not replace unreadable personal data with an empty state', async () => {
  const path = await root()
  await writeFile(join(path, 'features.json'), '{interrupted')
  await expect(
    new CommunityFeatureStore(path).mutate({ action: 'save', number: 42 })
  ).rejects.toThrow()
  expect(await readFile(join(path, 'features.json'), 'utf8')).toBe('{interrupted')
})
it('rejects altered evidence while retaining the original audit reference', async () => {
  const path = await root()
  const evidence = new CommunityEvidenceStore(path)
  const id = await evidence.save({ headSha: first, checks: ['failed'] })
  expect(await evidence.read(id)).toEqual({ headSha: first, checks: ['failed'] })
  await writeFile(join(path, `${id}.json`), '{"checks":["passed"]}')
  await expect(evidence.read(id)).rejects.toThrow()
})
