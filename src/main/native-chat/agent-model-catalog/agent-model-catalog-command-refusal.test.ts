import { expect, it } from 'vitest'
import { AgentSessionPreSpawnError } from '../agent-session-wire/providers/structured-agent-session-adapter-errors'
import { harness, ids } from './agent-model-catalog-account-list-test-support'
import { AGENT_MODEL_CATALOG_FAILURE_TTL_MS } from './agent-model-catalog-failures'
import { AgentModelCatalogStore } from './agent-model-catalog-store'

type Harness = ReturnType<typeof harness>

const inFolder = (read: Harness['read'], extra = {}) =>
  read('picker', {
    sessionId: undefined,
    workspacePath: '/project-a',
    waitForListing: true,
    ...extra
  })

const recovers = (resolve: Harness['resolve']) =>
  resolve.mock.calls.filter((call) => call[2] === 'recover').length

const refuse = async (): Promise<never> => {
  throw new AgentSessionPreSpawnError('the codex Command setting is not a runnable program', {
    reason: 'agentCommandNotRunnable'
  })
}

it("a Command setting that is not a runnable program says why alongside the account's saved list", async () => {
  const { probes, read } = harness('codex')
  await read('picker', { sessionId: undefined, waitForListing: true })
  probes.codex!.resolve = refuse
  const answer = await inFolder(read)
  expect(ids(answer)).toEqual(['gpt-a', 'gpt-b', 'gpt-c'])
  expect(answer.unavailable).toEqual({ reason: 'agentCommandNotRunnable' })
})

it('a held refusal is looked up again only once it expires, and a fixed Command lists', async () => {
  let now = 1000
  const { read, resolve, resolveScope } = harness('codex', {
    store: new AgentModelCatalogStore({ now: () => now })
  })
  resolve.mockImplementation(refuse)
  await inFolder(read)
  await inFolder(read)
  expect(recovers(resolve)).toBe(1)
  resolve.mockImplementation(resolveScope)
  now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS
  const answer = await inFolder(read)
  expect(recovers(resolve)).toBe(2)
  expect(ids(answer)).toEqual(['gpt-a', 'gpt-b', 'gpt-c'])
  expect(answer.unavailable).toBeUndefined()
})

it('a listing refused for the same reason answers why too', async () => {
  const { read } = harness('codex', { probes: { codex: refuse } })
  const answer = await read('picker', { sessionId: undefined, legacy: true, waitForListing: true })
  expect(answer).toMatchObject({ unavailable: { reason: 'agentCommandNotRunnable' } })
})

it("one folder's held refusal does not stand for another folder", async () => {
  const { read, resolve, resolveScope } = harness('codex')
  // A relative PATH entry finds the Command from /project-b once its shell is read.
  resolve.mockImplementation((...args) =>
    args[4] === '/project-b' && args[2] === 'recover' ? resolveScope(...args) : refuse()
  )
  expect((await inFolder(read)).unavailable).toEqual({ reason: 'agentCommandNotRunnable' })
  const answer = await inFolder(read, { workspacePath: '/project-b' })
  expect(ids(answer)).toEqual(['gpt-a', 'gpt-b', 'gpt-c'])
  expect(answer.unavailable).toBeUndefined()
})

it('a Refresh rechecks a held refusal at once', async () => {
  const { read, resolve, resolveScope } = harness('codex')
  resolve.mockImplementation(refuse)
  await inFolder(read)
  // A PATH fixed in the shell profile shows only once the shell is read again.
  resolve.mockImplementation((...args) =>
    args[2] === 'recover' ? resolveScope(...args) : refuse()
  )
  const answer = await inFolder(read, { relist: true })
  expect(ids(answer)).toEqual(['gpt-a', 'gpt-b', 'gpt-c'])
  expect(answer.unavailable).toBeUndefined()
})

it('a Refresh pressed during a running lookup still rechecks a held refusal', async () => {
  const { full, read, resolve, resolveScope } = harness('codex')
  resolve.mockImplementation(refuse)
  await inFolder(read)
  const started = Promise.withResolvers<void>()
  const snapshot = Promise.withResolvers<void>()
  resolve.mockImplementation(async (...args) => {
    if (args[2] === 'recover') {
      return resolveScope(...args)
    }
    started.resolve()
    await snapshot.promise
    return refuse()
  })
  const running = inFolder(read)
  await started.promise
  const refreshed = inFolder(read, { relist: true })
  snapshot.resolve()
  const answer = await refreshed
  expect(ids(answer)).toEqual(full)
  expect(answer.unavailable).toBeUndefined()
  await running
})

it('a Refresh on a Command still refused keeps the new hold', async () => {
  const { read, resolve } = harness('codex')
  resolve.mockImplementation(refuse)
  await inFolder(read)
  await inFolder(read, { relist: true })
  expect(recovers(resolve)).toBe(2)
  await inFolder(read)
  expect(recovers(resolve)).toBe(2)
})

it('a saved-only read drops a held refusal its own lookup no longer gives', async () => {
  const { read, resolve, service, store } = harness('codex')
  resolve.mockImplementation(refuse)
  await inFolder(read)
  // The Command is cleared, and only a Windows copy of codex is found in WSL.
  store.expireAgent('codex')
  resolve.mockImplementation(async () => {
    throw new AgentSessionPreSpawnError('codex is not installed', { reason: 'cliMissing' })
  })
  const saved = () => service.prepareSaved({ agent: 'codex', workspacePath: '/project-a' })
  expect((await saved()).unavailable).toBeUndefined()
  resolve.mockImplementation(refuse)
  expect((await saved()).unavailable).toEqual({ reason: 'agentCommandNotRunnable' })
})
