import { expect, it, onTestFinished, vi } from 'vitest'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import { AgentModelCatalogStore } from './agent-model-catalog-store'
import type { AgentModelCatalogSuccess } from './agent-model-catalog-entry'
import type { AgentModelCatalogProbe } from './agent-model-catalog-discovery'
import { AgentModelCatalogAdmission } from './agent-model-catalog-admission'
import { runAgentModelCatalogSession } from './agent-model-catalog-probe-runner'

function listing(id: string): AgentModelCatalogSuccess {
  return {
    models: [{ id, label: id, isDefault: true, efforts: [] }],
    origin: 'probe',
    complete: true
  }
}

it('isolates stalled account invocations while an unrelated provider lists and late models publish', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const answers = new Map<string, PromiseWithResolvers<AgentModelCatalogSuccess>>()
  const signals = new Map<string, AbortSignal | undefined>()
  const run = (folder: string, signal?: AbortSignal): Promise<AgentModelCatalogSuccess> => {
    signals.set(folder, signal)
    if (folder === '/folder-c') {
      return Promise.resolve(listing('third-account-child'))
    }
    const answer = Promise.withResolvers<AgentModelCatalogSuccess>()
    answers.set(folder, answer)
    return new Promise((resolve, reject) => {
      void answer.promise.then(resolve)
      signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
    })
  }
  const resolve: NonNullable<AgentModelCatalogProbe['resolve']> = async (
    _home,
    _cwd,
    _lookup,
    _operation,
    folder
  ) => ({
    identity: folder ?? 'account',
    run: (signal?: AbortSignal) => run(folder ?? '', signal)
  })
  const codex: AgentModelCatalogProbe = Object.assign(async () => listing('unused'), { resolve })
  const store = new AgentModelCatalogStore()
  const service = createAgentModelCatalogService({
    store,
    probes: { codex, pi: async () => listing('unrelated-provider-model') },
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: '/account' })
  })
  onTestFinished(() => service.stop())
  const first = service.read({ agent: 'codex', workspacePath: '/folder-a', waitForListing: true })
  const second = service.read({ agent: 'codex', workspacePath: '/folder-b', waitForListing: true })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(answers.has('/folder-a') && answers.has('/folder-b')).toBe(true)
  const related = service.read({ agent: 'codex', workspacePath: '/folder-c', waitForListing: true })
  const third = service.read({ agent: 'pi', waitForListing: true })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await third).toMatchObject({ models: [{ id: 'unrelated-provider-model' }] })
  expect(await first).toMatchObject({ listingInProgress: true, waitExpired: true })
  expect(await second).toMatchObject({ listingInProgress: true, waitExpired: true })
  expect((await related).origin).toBe('unknown')
  expect(signals.get('/folder-a')?.aborted).toBe(false)
  expect(signals.get('/folder-b')?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(14_000)
  answers.get('/folder-a')?.resolve(listing('late-codex-model'))
  await vi.advanceTimersByTimeAsync(0)
  expect(service.snapshot({ agent: 'codex', workspacePath: '/folder-a' })).toMatchObject({
    models: [{ id: 'late-codex-model' }]
  })
  expect(
    service.snapshot({ agent: 'codex', workspacePath: '/folder-a' }).listingInProgress
  ).toBeUndefined()
})

it('holds account capacity through retired session teardown while releasing startup admission', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const store = new AgentModelCatalogStore()
  const admission = new AgentModelCatalogAdmission()
  const account = admission.forAccount('grok/account')
  const closes = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const flights = closes.map((close, index) =>
    store.refresh(
      `folder-${index}`,
      'grok',
      async (_selected, owner) =>
        runAgentModelCatalogSession(
          () => ({ close: () => close.promise }),
          async () => new Promise<AgentModelCatalogSuccess>(() => {}),
          { label: 'grok', signal: owner.signal, timeoutMs: null }
        ),
      { admission: account }
    )
  )
  onTestFinished(async () => {
    for (const close of closes) {
      close.resolve()
    }
    store.expireScopes()
    await Promise.all(flights)
  })
  await vi.advanceTimersByTimeAsync(1_000)
  store.expireScopes('grok')
  const replacement = store.refresh('replacement', 'grok', async () => listing('replacement'), {
    admission: account
  })
  const unrelated = store.refresh('unrelated', 'pi', async () => listing('unrelated'), {
    admission: admission.forAccount('pi/account')
  })
  await vi.advanceTimersByTimeAsync(0)
  expect((await unrelated)?.models[0]?.id).toBe('unrelated')
  expect(store.get('replacement')).toBeNull()
  closes[0].resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect((await replacement)?.models[0]?.id).toBe('replacement')
  closes[1].resolve()
  expect(await Promise.all(flights)).toEqual([null, null])
})

it('reclaims aborted account and startup waiters without leaking or over-releasing capacity', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const admission = new AgentModelCatalogAdmission()
  const account = admission.forAccount('a')
  const first = await account.acquire(0)
  const second = await account.acquire(0)
  const waiting = new AbortController()
  const accountWait = account.acquire(0, waiting.signal)
  const accountRejected = expect(accountWait).rejects.toBe('cancel-account')
  waiting.abort('cancel-account')
  await accountRejected
  const other = admission.forAccount('b')
  const hostWaiting = new AbortController()
  const hostWait = other.acquire(0, hostWaiting.signal)
  const hostRejected = expect(hostWait).rejects.toBe('cancel-startup')
  await vi.advanceTimersByTimeAsync(0)
  hostWaiting.abort('cancel-startup')
  await hostRejected
  first()
  first()
  const recovered = await account.acquire(0)
  let extra: (() => void) | undefined
  const extraWait = account.acquire(0).then((release) => {
    extra = release
  })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(extra).toBeUndefined()
  const independent = await other.acquire(0)
  independent()
  independent()
  second()
  await extraWait
  extra?.()
  recovered()
  const again = await Promise.all([account.acquire(0), account.acquire(0)])
  for (const release of again) {
    release()
  }
})
