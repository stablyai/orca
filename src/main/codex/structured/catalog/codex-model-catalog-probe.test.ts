import { runAgentModelCatalogSession } from '../../../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { PrioritySemaphore } from '../../../../shared/priority-semaphore'
import type { AgentModelCatalogSuccess } from '../../../native-chat/agent-model-catalog/agent-model-catalog-entry'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getSystemCodexHomePath,
  resolveOrcaManagedCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import { createAgentModelCatalogService } from '../../../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../../../native-chat/agent-model-catalog/agent-model-catalog-store'
import { afterEach, describe, expect, it, vi, onTestFinished } from 'vitest'
import { createCodexModelCatalogProbe } from './codex-model-catalog-probe'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'
import {
  runCodexAppServerSession,
  type CodexAppServerInvocation
} from '../../app-server/codex-app-server-session'

const MODEL_ROW = {
  model: 'gpt-live',
  displayName: 'GPT Live',
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
  isDefault: true
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('codex model catalog probe', () => {
  it.each([
    [[], ['/orca-probe', '/orca-probe']],
    [['node_modules/@openai/codex/bin/codex.js'], ['/chat-a', '/chat-b']],
    [
      ['-c', 'model_instructions_file="./prompt.md"'],
      ['/chat-a', '/chat-b']
    ]
  ])('lists a command line with arguments %j from %j', async (prefixArgs, listedIn) => {
    // Only the plain CLI shares one listing; user arguments may name files in the chat's folder.
    const invocations: CodexAppServerInvocation[] = []
    const configReads: unknown[] = []
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({ PATH: '/bin' }),
      resolveCommand: () => ({ command: '/bin/codex', prefixArgs }),
      runSession: async (invocation, body) => {
        invocations.push(invocation)
        return body({
          request: async (method: string, params: unknown) => {
            if (method === 'config/read') {
              configReads.push(params)
              return { config: {} }
            }
            return { data: [MODEL_ROW], nextCursor: null }
          },
          notify: () => {}
        })
      }
    })
    const identities: unknown[] = []
    for (const folder of ['/chat-a', '/chat-b']) {
      const resolved = await probe.resolve?.(
        { variable: 'CODEX_HOME', path: '/homes/a' },
        '/orca-probe',
        'snapshot',
        undefined,
        folder
      )
      identities.push(resolved?.identity)
      await resolved?.run()
    }
    expect(invocations.map((invocation) => invocation.cwd)).toEqual(listedIn)
    expect(invocations[0]?.args.slice(0, prefixArgs.length)).toEqual(prefixArgs)
    // A listing in the chat's folder never loads that folder's project config.
    expect(invocations[0]?.args.includes('projects={"/chat-a"={trust_level="untrusted"}}')).toBe(
      listedIn[0] === '/chat-a'
    )
    expect(invocations[0]?.args).toContain('project_root_markers=[]')
    expect(identities[0]).toMatchObject({ cwd: listedIn[0] })
    expect(JSON.stringify(identities[0]) === JSON.stringify(identities[1])).toBe(
      listedIn[0] === listedIn[1]
    )
    // The account's configured default is read for Orca's folder, never the project's.
    expect(configReads).toEqual(
      expect.arrayContaining([expect.objectContaining({ cwd: '/orca-probe' })])
    )
  })

  it('keeps the listing when config/read never answers', async () => {
    const server = String.raw`
      const readline = require('node:readline')
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line)
        if (typeof message.id !== 'number' || message.method === 'config/read') return
        const result = message.method === 'model/list'
          ? { data: [${JSON.stringify(MODEL_ROW)}], nextCursor: null }
          : {}
        process.stdout.write(JSON.stringify({ id: message.id, result }) + '\n')
      })
    `
    const configReadTimeouts: (number | null | undefined)[] = []
    const configReadFailures: unknown[] = []
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({ PATH: '/bin' }),
      resolveCommand: () => ({ command: '/bin/codex', prefixArgs: [] }),
      // Keep the real request timeout while checking the production budget below.
      runSession: (invocation, body) =>
        runCodexAppServerSession(
          {
            ...invocation,
            command: process.execPath,
            cliPath: null,
            args: ['-e', server],
            timeoutMs: 6_000
          },
          (rpc) =>
            body({
              ...rpc,
              request: async (method, params, options) => {
                if (method !== 'config/read') {
                  return rpc.request(method, params, options)
                }
                configReadTimeouts.push(options?.timeoutMs)
                try {
                  return await rpc.request(method, params, { ...options, timeoutMs: 20 })
                } catch (error) {
                  configReadFailures.push(error)
                  throw error
                }
              }
            })
        )
    })
    const success = await probe({ variable: 'CODEX_HOME', path: '/homes/a' })
    expect(success.complete).toBe(false)
    expect(configReadTimeouts).toEqual([null])
    expect(configReadFailures).toEqual([
      expect.objectContaining({
        name: 'CodexAppServerTimeoutError',
        message: 'codex app-server config/read exceeded 20ms'
      })
    ])
    expect(success.models.map((model) => ({ id: model.id, isDefault: model.isDefault }))).toEqual([
      { id: 'gpt-live', isDefault: true }
    ])
  }, 10_000)
})

it('observes the shared source config while ignoring mirror writes, and observes a self-contained home itself', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'orca-codex-input-source-'))
  vi.stubEnv('HOME', folder)
  vi.stubEnv('USERPROFILE', folder)
  vi.stubEnv('ORCA_USER_DATA_PATH', join(folder, 'user-data'))
  const source = getSystemCodexHomePath()
  const mirror = resolveOrcaManagedCodexHomePath()
  const own = join(folder, 'account')
  expect(source.startsWith(folder)).toBe(true)
  await Promise.all([source, mirror, own].map((path) => mkdir(path, { recursive: true })))
  for (const path of [source, mirror, own]) {
    await writeFile(join(path, 'config.toml'), 'model="original"')
  }
  let model = 'original'
  let account = mirror
  const probe = createCodexModelCatalogProbe({
    resolveEnvironment: async () => ({}),
    resolveCommand: () => ({ command: process.execPath, prefixArgs: [] }),
    runSession: async (_invocation, body) =>
      body({
        request: async (method) =>
          method === 'model/list'
            ? { data: [{ ...MODEL_ROW, model }], nextCursor: null }
            : method === 'config/read'
              ? { config: {} }
              : {},
        notify: () => {}
      })
  })
  const service = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: account }),
    probes: { codex: probe }
  })
  try {
    const read = () => service.read({ agent: 'codex', workspacePath: folder, waitForListing: true })
    expect(await read()).toMatchObject({ models: [{ id: 'original' }] })
    model = 'changed'
    await writeFile(join(mirror, 'config.toml'), 'model="mirrored-probe-write"')
    expect(await read()).toMatchObject({ models: [{ id: 'original' }] })
    await writeFile(join(source, 'config.toml'), 'model="source-changed"')
    expect(await read()).toMatchObject({ models: [{ id: 'changed' }] })
    account = own
    expect(await read()).toMatchObject({ models: [{ id: 'changed' }] })
    model = 'own-changed'
    await writeFile(join(own, 'config.toml'), 'model="own-changed"')
    expect(await read()).toMatchObject({ models: [{ id: 'own-changed' }] })
  } finally {
    await service.stop()
    await rm(folder, { recursive: true, force: true })
  }
})

it('delivers inventory while config and account are pending, then keeps both late replies', async () => {
  const config = Promise.withResolvers<unknown>()
  const account = Promise.withResolvers<unknown>()
  const inventoried = Promise.withResolvers<void>()
  const observations: AgentModelCatalogSuccess[] = []
  const probe = createCodexModelCatalogProbe({
    resolveEnvironment: async () => ({}),
    resolveCommand: () => ({ command: process.execPath, prefixArgs: [] }),
    runSession: async (_invocation, body) =>
      body({
        request: async (method, _params, options) => {
          if (options?.timeoutMs !== null) {
            throw new Error('catalog request retained its response deadline')
          }
          if (method === 'config/read') {
            return config.promise
          }
          if (method === 'account/read') {
            return account.promise
          }
          return { data: [MODEL_ROW], nextCursor: null }
        },
        notify: () => {}
      })
  })
  const done = probe(
    { variable: 'CODEX_HOME', path: '/account' },
    {
      publish: (success) => {
        observations.push(success)
        inventoried.resolve()
      }
    }
  )
  await inventoried.promise
  expect(observations[0]).toMatchObject({ models: [{ id: 'gpt-live' }], complete: false })
  expect(observations[0].configured).toBeUndefined()
  config.resolve({ config: { model: 'gpt-live', model_reasoning_effort: 'high' } })
  account.resolve({ requiresOpenaiAuth: true, account: null })
  expect(await done).toMatchObject({
    models: [{ id: 'gpt-live', defaultEffort: 'high' }],
    complete: true,
    unavailable: { reason: 'notSignedIn' }
  })
  expect(observations[0].complete).toBe(false)
})

it.each([
  ['empty', { requiresOpenaiAuth: true, account: null }, 'notSignedIn'],
  ['rejected', { requiresOpenaiAuth: true, account: null }, 'notSignedIn'],
  ['empty', { requiresOpenaiAuth: false, account: { type: 'apiKey' } }, undefined],
  ['empty', {}, undefined]
] as const)(
  'classifies %s inventory after delayed account evidence %j without optional config, retaining admission through close',
  async (kind, accountResult, reason) => {
    const configRead = vi.fn(() => new Promise<never>(() => {}))
    const account = Promise.withResolvers<unknown>()
    const inventory = Promise.withResolvers<void>()
    const closing = Promise.withResolvers<void>()
    const closed = Promise.withResolvers<void>()
    onTestFinished(() => {
      account.resolve({ requiresOpenaiAuth: true, account: null })
      closed.resolve()
    })
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({}),
      resolveCommand: () => ({ command: process.execPath, prefixArgs: [] }),
      runSession: async (invocation, body) =>
        runAgentModelCatalogSession(
          () => ({
            request: async (method: string) => {
              if (method === 'account/read') {
                return account.promise
              }
              if (method === 'config/read') {
                return configRead()
              }
              inventory.resolve()
              if (kind === 'rejected') {
                throw new Error('model listing refused')
              }
              return { data: [], nextCursor: null }
            },
            notify: () => {},
            close: () => {
              closing.resolve()
              return closed.promise
            }
          }),
          body,
          { label: 'codex', signal: invocation.signal, timeoutMs: null }
        )
    })
    const store = new AgentModelCatalogStore()
    const admission = new PrioritySemaphore(1)
    const first = store.refresh(
      'signed-out',
      'codex',
      (_selected, operation) =>
        probe(
          { variable: 'CODEX_HOME', path: '/account' },
          { operation, signal: operation.signal }
        ),
      { admission }
    )
    await inventory.promise
    expect(store.failure('signed-out')).toBeNull()
    expect(store.isListing('signed-out')).toBe(true)
    account.resolve(accountResult)
    await closing.promise
    let nextStarted = false
    const next = store.refresh(
      'next',
      'codex',
      async () => {
        nextStarted = true
        return {
          origin: 'probe',
          complete: true,
          models: [{ id: 'next', label: 'Next', isDefault: true, efforts: [] }]
        }
      },
      { admission }
    )
    await Promise.resolve()
    expect(nextStarted).toBe(false)
    closed.resolve()
    expect(await first).toBeNull()
    expect(configRead).not.toHaveBeenCalled()
    expect(store.failure('signed-out')).not.toBeNull()
    expect(store.failure('signed-out')?.unavailable).toEqual(reason ? { reason } : undefined)
    expect((await next)?.models[0]?.id).toBe('next')
  }
)

// A real child must complete startup and supervised shutdown within this wall-clock budget.
it('settles a failed inventory and pending sign-in classification when the real transport closes', async () => {
  const server = String.raw`
    const readline = require('node:readline')
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const message = JSON.parse(line)
      if (message.method === 'account/read') return
      if (message.method === 'model/list') {
        process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32000, message: 'inventory unavailable' } }) + '\n', () => process.exit(1))
        return
      }
      if (typeof message.id === 'number') process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n')
    })
  `
  const store = new AgentModelCatalogStore()
  const probe = createCodexModelCatalogProbe({
    resolveEnvironment: async () => ({}),
    resolveCommand: () => ({ command: process.execPath, prefixArgs: [] }),
    runSession: (invocation, body) =>
      runCodexAppServerSession(
        { ...invocation, command: process.execPath, cliPath: null, args: ['-e', server] },
        body
      )
  })
  const home = { variable: 'CODEX_HOME', path: '/account' }
  await expect(
    store.refresh('closed', 'codex', async (_models, operation) =>
      probe(home, { operation, signal: operation.signal })
    )
  ).resolves.toBeNull()
  expect(store.isListing('closed')).toBe(false)
  expect(store.failure('closed')).not.toBeNull()
}, 10_000)

it('keeps a later nonempty page and late configured model after an empty first page', async () => {
  const config = Promise.withResolvers<unknown>()
  const observations: string[][] = []
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'config/read') {
      return config.promise
    }
    return (params as { cursor?: string }).cursor
      ? { data: [MODEL_ROW], nextCursor: null }
      : { data: [], nextCursor: 'next' }
  })
  const result = fetchCodexModelCatalogListing({
    connection: { request },
    timeoutMs: null,
    publish: (listing) => observations.push(listing.models.map((model) => model.id))
  })
  await vi.waitFor(() => expect(observations).toEqual([['gpt-live']]))
  config.resolve({ config: { model: 'gpt-live', model_reasoning_effort: 'high' } })
  expect(await result).toMatchObject({
    complete: true,
    models: [{ id: 'gpt-live' }],
    configured: { model: 'gpt-live', effort: 'high' }
  })
})

it.each(['empty', 'malformed', 'capped'])(
  'returns incomplete %s inventory without optional configuration',
  async (kind) => {
    const request = vi.fn(async (method: string) => {
      if (method === 'config/read') {
        throw new Error('configuration cannot provide inventory')
      }
      return kind === 'malformed'
        ? { data: [{}], nextCursor: null }
        : { data: [], nextCursor: kind === 'capped' ? 'more' : null }
    })
    expect(
      await fetchCodexModelCatalogListing({ connection: { request }, timeoutMs: null })
    ).toEqual({ models: [], complete: false })
    expect(request.mock.calls.every(([method]) => method === 'model/list')).toBe(true)
  }
)
