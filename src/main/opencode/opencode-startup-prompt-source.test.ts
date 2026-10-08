import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OPENCODE_STARTUP_PROMPT_SHA256_ENV,
  OPENCODE_STARTUP_PROMPT_NONCE_ENV,
  OPENCODE_STARTUP_PROMPT_BODY_ENV,
  OPENCODE_STARTUP_PROMPT_ENDPOINT_ENV
} from '../../shared/opencode-startup-prompt'
import { getOpenCodeStartupPromptSource } from './opencode-startup-prompt-source'
import { OpenCodeStartupPromptClaims } from './opencode-startup-prompt-claims'
import { cancelTrackingResponse } from '../lib/unread-response-body.test-fixtures'

type PluginModule = { default: { setup: (ctx: unknown) => Promise<() => Promise<void>> } }
const prompt = 'exact startup brief\nwith unicode é'
const digest = createHash('sha256').update(prompt).digest('hex')
let dir: string
let setup: PluginModule['default']['setup']
let claim: ReturnType<typeof vi.fn>

class Editor extends EventEmitter {
  traits: { owner: string; role: string; capture: string[]; status?: string } = {
    owner: 'opencode',
    role: 'prompt',
    capture: ['tab']
  }
  plainText = ''
  focused = true
  insertText(text: string) {
    this.replace(this.plainText + text)
  }
  replace(text: string) {
    this.plainText = text
    this.emit('line-info-change')
  }
}

type FixtureLocation = { directory: string; workspaceID?: string }

function fixture(version = '2.0.16') {
  const editor = new Editor()
  const input = new EventEmitter()
  const memory = { settled: false, expiresAt: Date.now() + 20000 }
  const route = { type: 'home' }
  const agent = vi.fn((): unknown[] | undefined => [{}])
  const model = vi.fn((): unknown[] | undefined => [{}])
  const sync = vi.fn(async (_location: FixtureLocation) => {})
  const dispatch = vi.fn(() => editor.replace(''))
  const ctx = {
    app: { version },
    renderer: { keyInput: input, currentFocusedEditor: editor },
    storage: { memory: () => [memory, (mutate: (draft: typeof memory) => void) => mutate(memory)] },
    keymap: { dispatch },
    ui: { router: { current: () => route } },
    location: { directory: '/private' },
    data: { location: { sync, agent: { list: agent }, model: { list: model } } }
  }
  return { ctx, editor, input, memory, route, agent, model, sync, dispatch }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-opencode-prompt-'))
  const path = join(dir, 'prompt.mjs')
  writeFileSync(path, getOpenCodeStartupPromptSource())
  const module: PluginModule = await import(pathToFileURL(path).href)
  setup = module.default.setup
  vi.useFakeTimers()
  vi.stubEnv(OPENCODE_STARTUP_PROMPT_SHA256_ENV, digest)
  vi.stubEnv(OPENCODE_STARTUP_PROMPT_BODY_ENV, prompt)
  vi.stubEnv(OPENCODE_STARTUP_PROMPT_NONCE_ENV, 'single-use-nonce')
  const endpoint = join(dir, 'endpoint.cmd')
  writeFileSync(
    endpoint,
    'set ORCA_AGENT_HOOK_PORT=12345\nset ORCA_AGENT_HOOK_TOKEN=private-token\nset ORCA_AGENT_HOOK_ENV=test\nset ORCA_AGENT_HOOK_VERSION=1\n'
  )
  vi.stubEnv(OPENCODE_STARTUP_PROMPT_ENDPOINT_ENV, endpoint)
  claim = vi.fn(async () => ({ ok: true, json: async () => ({ allowed: true }) }))
  vi.stubGlobal('fetch', claim)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('installed-version native prompt intent plugin', () => {
  it.each(['2.0.12', '2.0.16'])(
    'hydrates the source-reviewed %s location and delivers the same intent only once',
    async (version) => {
      const f = fixture(version)
      let hydrate = () => {}
      f.sync.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            hydrate = resolve
          })
      )
      const insert = vi.spyOn(f.editor, 'insertText')
      const dispose = await setup(f.ctx)
      try {
        await vi.advanceTimersByTimeAsync(500)
        expect(f.sync).toHaveBeenCalledExactlyOnceWith(f.ctx.location)
        expect(claim).not.toHaveBeenCalled()
        expect(insert).not.toHaveBeenCalled()
        hydrate()
        await vi.advanceTimersByTimeAsync(1000)
        await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1))
        expect(insert).toHaveBeenCalledExactlyOnceWith(prompt)
        expect(f.dispatch).toHaveBeenCalledExactlyOnceWith('prompt.submit')
        expect(f.memory.settled).toBe(true)
        const reloadDispose = await setup(f.ctx)
        await vi.advanceTimersByTimeAsync(500)
        expect(claim).toHaveBeenCalledTimes(1)
        expect(f.dispatch).toHaveBeenCalledTimes(1)
        await reloadDispose()
      } finally {
        await dispose()
      }
    }
  )

  it('waits for the current home location after the startup directory changes', async () => {
    const f = fixture()
    let location: FixtureLocation = { directory: '/private/home/private-folder' }
    Object.defineProperty(f.ctx, 'location', { get: () => location })
    let releaseStartup = () => {}
    let releaseHome = () => {}
    let selectedModel = 'opencode/mimo-v2.6-flash-free'
    const selections: string[] = []
    f.sync.mockImplementation(
      (target) =>
        new Promise<void>((resolve) => {
          if (target.directory.endsWith('/private-folder')) {
            releaseStartup = resolve
          } else {
            releaseHome = () => {
              selectedModel = 'private-proof/model-a'
              resolve()
            }
          }
        })
    )
    f.dispatch.mockImplementation(() => {
      selections.push(selectedModel)
      f.editor.replace('')
    })
    const dispose = await setup(f.ctx)
    try {
      await vi.advanceTimersByTimeAsync(100)
      location = { directory: '/private/home' }
      releaseStartup()
      await vi.advanceTimersByTimeAsync(300)
      expect(claim).not.toHaveBeenCalled()
      expect(selections).toEqual([])
      expect(f.sync).toHaveBeenCalledTimes(2)
      expect(f.sync).toHaveBeenLastCalledWith(location)
      releaseHome()
      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1))
      expect(selections).toEqual(['private-proof/model-a'])
      expect(claim).toHaveBeenCalledTimes(1)
    } finally {
      await dispose()
    }
  })

  it('waits for a concrete location before starting authoritative hydration', async () => {
    const f = fixture()
    let location: FixtureLocation | undefined
    Object.defineProperty(f.ctx, 'location', { get: () => location })
    const dispose = await setup(f.ctx)
    try {
      await vi.advanceTimersByTimeAsync(300)
      expect(f.sync).not.toHaveBeenCalled()
      expect(claim).not.toHaveBeenCalled()
      location = { directory: '/private/home' }
      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1))
      expect(f.sync).toHaveBeenCalledExactlyOnceWith(location)
    } finally {
      await dispose()
    }
  })

  it('keeps readiness scoped to the workspace as well as the directory', async () => {
    const f = fixture()
    let location: FixtureLocation = { directory: '/private', workspaceID: 'first' }
    Object.defineProperty(f.ctx, 'location', { get: () => location })
    let release = () => {}
    f.sync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const dispose = await setup(f.ctx)
    try {
      await vi.advanceTimersByTimeAsync(100)
      location = { directory: '/private', workspaceID: 'second' }
      release()
      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1))
      expect(f.sync).toHaveBeenCalledTimes(2)
      expect(f.sync).toHaveBeenLastCalledWith(location)
      expect(claim).toHaveBeenCalledTimes(1)
    } finally {
      await dispose()
    }
  })

  it('refuses a granted claim after the composer location changes', async () => {
    const f = fixture()
    let location: FixtureLocation = { directory: '/private' }
    Object.defineProperty(f.ctx, 'location', { get: () => location })
    let grant = () => {}
    claim.mockImplementation(
      () =>
        new Promise((resolve) => {
          grant = () => resolve({ ok: true, json: async () => ({ allowed: true }) })
        })
    )
    const insert = vi.spyOn(f.editor, 'insertText')
    const dispose = await setup(f.ctx)
    try {
      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1))
      location = { directory: '/private/other' }
      grant()
      await vi.advanceTimersByTimeAsync(500)
      expect(insert).not.toHaveBeenCalled()
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(f.memory.settled).toBe(true)
    } finally {
      await dispose()
    }
  })

  it('waits for authoritative location config before claiming or selecting a model', async () => {
    const f = fixture()
    let configuredModel = 'unavailable-fallback'
    let release = () => {}
    f.sync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            configuredModel = 'configured-model'
            resolve()
          }
        })
    )
    const selections: string[] = []
    f.dispatch.mockImplementation(() => {
      selections.push(configuredModel)
      f.editor.replace('')
    })
    const insert = vi.spyOn(f.editor, 'insertText')
    const dispose = await setup(f.ctx)
    try {
      await vi.advanceTimersByTimeAsync(500)
      expect(claim).not.toHaveBeenCalled()
      expect(insert).not.toHaveBeenCalled()
      expect(selections).toEqual([])
      expect(f.sync).toHaveBeenCalledExactlyOnceWith(f.ctx.location)
      release()
      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledExactlyOnceWith('prompt.submit'))
      expect(selections).toEqual(['configured-model'])
      expect(insert).toHaveBeenCalledExactlyOnceWith(prompt)
      expect(claim).toHaveBeenCalledTimes(1)
      expect(f.sync).toHaveBeenCalledTimes(1)
    } finally {
      await dispose()
    }
  })

  it.each(['keypress', 'paste', 'edit', 'route', 'expiry', 'dispose', 'editor', 'focus'])(
    'cancels delayed location hydration on %s before any claim',
    async (reason) => {
      const f = fixture()
      let release = () => {}
      f.sync.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      )
      const dispose = await setup(f.ctx)
      try {
        await vi.advanceTimersByTimeAsync(100)
        expect(claim).not.toHaveBeenCalled()
        if (reason === 'keypress' || reason === 'paste') {
          f.input.emit(reason)
        }
        if (reason === 'edit') {
          f.editor.replace('typed')
          f.editor.replace('')
        }
        if (reason === 'route') {
          f.route.type = 'session'
        }
        if (reason === 'expiry') {
          f.memory.expiresAt = Date.now()
        }
        if (reason === 'dispose') {
          await dispose()
        }
        if (reason === 'editor') {
          f.ctx.renderer.currentFocusedEditor = new Editor()
        }
        if (reason === 'focus') {
          f.editor.focused = false
        }
        await vi.advanceTimersByTimeAsync(100)
        release()
        await vi.advanceTimersByTimeAsync(500)
        expect(claim).not.toHaveBeenCalled()
        expect(f.dispatch).not.toHaveBeenCalled()
        expect(f.editor.plainText).toBe('')
        if (reason !== 'focus') {
          expect(f.memory.settled).toBe(true)
        }
      } finally {
        await dispose()
      }
      expect(f.input.listenerCount('keypress')).toBe(0)
      expect(f.editor.listenerCount('line-info-change')).toBe(0)
    }
  )

  it('fails closed when authoritative location sync rejects', async () => {
    const f = fixture()
    f.sync.mockRejectedValue(new Error('location unavailable'))
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.memory.settled).toBe(true)
    expect(claim).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.input.listenerCount('keypress')).toBe(0)
    await dispose()
  })

  it('fails closed when authoritative location sync is missing', async () => {
    const f = fixture()
    const { sync: _sync, ...location } = f.ctx.data.location
    const dispose = await setup({ ...f.ctx, data: { location } })
    await vi.advanceTimersByTimeAsync(500)
    expect(claim).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.input.listenerCount('keypress')).toBe(0)
    await dispose()
  })

  it.each(['non-ok', 'json-rejected'])('cancels unread %s claim bodies', async (reason) => {
    const cancelled = vi.fn()
    const response = cancelTrackingResponse(reason === 'non-ok' ? 503 : 200, cancelled)
    if (reason === 'json-rejected') {
      vi.spyOn(response, 'json').mockRejectedValue(new Error('decoder rejected'))
    }
    claim.mockResolvedValue(response)
    const f = fixture()
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled())
    expect(f.memory.settled).toBe(false)
    expect(f.dispatch).not.toHaveBeenCalled()
    await dispose()
    expect(f.memory.settled).toBe(true)
  })

  it('consumes an allowed claim body before dispatching the prompt', async () => {
    const response = Response.json({ allowed: true })
    claim.mockResolvedValue(response)
    const f = fixture()
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledExactlyOnceWith('prompt.submit'))
    expect(response.bodyUsed).toBe(true)
    await dispose()
  })

  it('consumes malformed JSON and retries without delivering until expiry', async () => {
    const response = new Response('{invalid', { status: 200 })
    claim.mockResolvedValue(response)
    const f = fixture()
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => {
      expect(response.bodyUsed).toBe(true)
      expect(claim.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    expect(f.memory.settled).toBe(false)
    f.memory.expiresAt = Date.now()
    await vi.advanceTimersByTimeAsync(100)
    expect(response.bodyUsed).toBe(true)
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.memory.settled).toBe(true)
    await dispose()
  })

  it.each(['dialog', 'shell', 'autocomplete'])('does not populate a %s editor', async (kind) => {
    const f = fixture()
    if (kind === 'dialog') {
      f.editor.traits.role = 'dialog'
    }
    if (kind === 'shell') {
      f.editor.traits.status = 'SHELL'
    }
    if (kind === 'autocomplete') {
      f.editor.traits.capture = ['escape', 'navigate', 'submit', 'tab']
    }
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.editor.plainText).toBe('')
    expect(claim).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
    await dispose()
  })
  it('retries pending admission, then submits once', async () => {
    claim.mockResolvedValueOnce({ ok: true, json: async () => ({ allowed: false, pending: true }) })
    const f = fixture()
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(100)
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1))
    expect(f.dispatch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1))
    expect(claim).toHaveBeenCalledTimes(2)
    await dispose()
  })

  it('cancels pending admission on input without retrying a consumed denial', async () => {
    claim.mockResolvedValue({ ok: true, json: async () => ({ allowed: false, pending: true }) })
    const f = fixture()
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(100)
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1))
    f.input.emit('keypress', { name: 'x' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(claim).toHaveBeenCalledTimes(1)
    expect(f.dispatch).not.toHaveBeenCalled()
    await dispose()
  })

  it('preserves typing that predates plugin setup without requesting owner permission', async () => {
    const f = fixture()
    f.editor.replace('early typing')
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.editor.plainText).toBe('early typing')
    expect(claim).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
    await dispose()
  })
  it('waits for catalogs and settles before a single dispatch', async () => {
    const f = fixture()
    f.model.mockReturnValue(undefined)
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.dispatch).not.toHaveBeenCalled()
    f.model.mockReturnValue([{}])
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledExactlyOnceWith('prompt.submit'))
    expect(claim).toHaveBeenCalledTimes(1)
    expect(f.memory.settled).toBe(true)
    f.editor.replace(prompt)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    await dispose()
    const reloadDispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    await reloadDispose()
  })

  it.each(['keypress', 'paste'])('cancels on physical %s before catalogs finish', async (event) => {
    const f = fixture()
    f.agent.mockReturnValue(undefined)
    const dispose = await setup(f.ctx)
    f.input.emit(event)
    f.agent.mockReturnValue([{}])
    await vi.advanceTimersByTimeAsync(500)
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.memory.settled).toBe(true)
    await dispose()
  })

  it('cancels a changed draft even when it is restored before the next tick', async () => {
    const f = fixture()
    f.model.mockReturnValue(undefined)
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(100)
    f.editor.replace('edited')
    f.editor.replace('')
    f.model.mockReturnValue([{}])
    await vi.advanceTimersByTimeAsync(500)
    expect(f.dispatch).not.toHaveBeenCalled()
    await dispose()
  })

  it('cancels pending intent on route changes, expiration and disposal', async () => {
    for (const reason of ['route', 'expiration', 'dispose']) {
      const f = fixture()
      f.model.mockReturnValue(undefined)
      const dispose = await setup(f.ctx)
      if (reason === 'route') {
        f.route.type = 'session'
      }
      if (reason === 'expiration') {
        f.memory.expiresAt = Date.now()
      }
      if (reason === 'dispose') {
        await dispose()
      }
      await vi.advanceTimersByTimeAsync(100)
      f.model.mockReturnValue([{}])
      await vi.advanceTimersByTimeAsync(500)
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(f.memory.settled).toBe(true)
      await dispose()
      expect(f.input.listenerCount('keypress')).toBe(0)
    }
  })

  it('leaves unverified versions and mismatched drafts unsubmitted', async () => {
    const f = fixture()
    f.ctx.app.version = '2.0.17'
    await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.dispatch).not.toHaveBeenCalled()
    f.ctx.app.version = '2.0.16'
    f.editor.replace('another brief')
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.dispatch).not.toHaveBeenCalled()
    await dispose()
  })

  it.each(['canceled', 'unavailable'])(
    'fails closed when the execution owner is %s',
    async (reason) => {
      claim.mockImplementation(async () => {
        if (reason === 'unavailable') {
          throw new Error('contact lost')
        }
        return { ok: true, json: async () => ({ allowed: false }) }
      })
      const f = fixture()
      const dispose = await setup(f.ctx)
      await vi.advanceTimersByTimeAsync(500)
      expect(f.dispatch).not.toHaveBeenCalled()
      if (reason === 'unavailable') {
        await vi.waitFor(() => expect(claim).toHaveBeenCalled())
        expect(f.memory.settled).toBe(false)
        f.memory.expiresAt = Date.now()
        await vi.advanceTimersByTimeAsync(100)
      }
      await vi.waitFor(() => expect(f.memory.settled).toBe(true))
      await dispose()
    }
  )

  it('rechecks physical cancellation after the owner response', async () => {
    const f = fixture()
    claim.mockImplementation(async () => {
      f.input.emit('keypress')
      return { ok: true, json: async () => ({ allowed: true }) }
    })
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(f.memory.settled).toBe(true))
    expect(f.dispatch).not.toHaveBeenCalled()
    await dispose()
  })
  it('settles before insertion and never repeats dispatch when the draft is retained', async () => {
    const f = fixture()
    f.dispatch.mockImplementation(() => {})
    const insert = vi.spyOn(f.editor, 'insertText')
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(1500)
    await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1))
    expect(insert).toHaveBeenCalledExactlyOnceWith(prompt)
    expect(f.memory.settled).toBe(true)
    expect(f.editor.plainText).toBe(prompt)
    await dispose()
    const reloadDispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    await reloadDispose()
  })

  it.each(['before-grant', 'after-grant', 'timeout-after-grant'])(
    'recovers actual HTTP response loss %s exactly once',
    async (phase) => {
      vi.useRealTimers()
      vi.unstubAllGlobals()
      const claims = new OpenCodeStartupPromptClaims()
      claims.register('single-use-nonce', digest, () => ({
        freshSpawn: true,
        firstUserInputAt: null
      }))
      let requests = 0
      const bodies: unknown[] = []
      const grants: (boolean | 'pending')[] = []
      let heldResponse: ReturnType<typeof setTimeout> | undefined
      const server = createServer(async (request, response) => {
        let text = ''
        for await (const chunk of request) {
          text += chunk.toString()
        }
        const body: unknown = JSON.parse(text)
        bodies.push(body)
        requests++
        if (requests === 1 && phase === 'before-grant') {
          response.writeHead(503).end('temporarily unavailable')
          return
        }
        const allowed = claims.claim(body)
        grants.push(allowed)
        if (requests === 1 && phase === 'after-grant') {
          response.destroy()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        if (requests === 1 && phase === 'timeout-after-grant') {
          response.write('{"allowed":')
          heldResponse = setTimeout(() => response.end('true}'), 1300)
          return
        }
        response.end(JSON.stringify({ allowed: allowed === true, pending: allowed === 'pending' }))
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('missing loopback address')
      }
      writeFileSync(
        join(dir, 'endpoint.cmd'),
        `set ORCA_AGENT_HOOK_PORT=${address.port}\nset ORCA_AGENT_HOOK_TOKEN=private-token\nset ORCA_AGENT_HOOK_ENV=test\nset ORCA_AGENT_HOOK_VERSION=1\n`
      )
      const f = fixture()
      const dispose = await setup(f.ctx)
      try {
        await vi.waitFor(
          () =>
            expect(
              f.dispatch,
              JSON.stringify({ phase, requests, bodies, grants })
            ).toHaveBeenCalledTimes(1),
          { timeout: 3000 }
        )
        await new Promise<void>((resolve) => setTimeout(resolve, 300))
        expect(requests).toBe(2)
        expect(grants).toEqual(phase === 'before-grant' ? [true] : [true, true])
        expect(bodies[1]).toEqual(bodies[0])
        expect(bodies[0]).toHaveProperty('requestId', expect.any(String))
        expect(f.memory.settled).toBe(true)
        expect(f.editor.plainText).toBe('')
      } finally {
        await dispose()
        claims.clear()
        clearTimeout(heldResponse)
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  )

  it.each([408, 429, 503])(
    'retries transient HTTP %s with one stable operation ID',
    async (status) => {
      claim.mockResolvedValueOnce({ ok: false, status })
      const f = fixture()
      const dispose = await setup(f.ctx)
      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1))
      const firstBody = JSON.parse(claim.mock.calls[0][1].body)
      expect(firstBody.requestId).toMatch(/^[a-f0-9-]{36}$/)
      expect(JSON.parse(claim.mock.calls[1][1].body)).toEqual(firstBody)
      expect(claim).toHaveBeenCalledTimes(2)
      await dispose()
    }
  )

  it.each([401, 403, 404])('settles HTTP %s denial without retrying', async (status) => {
    claim.mockResolvedValue({ ok: false, status })
    const f = fixture()
    const dispose = await setup(f.ctx)
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => expect(f.memory.settled).toBe(true))
    expect(claim).toHaveBeenCalledTimes(1)
    expect(f.dispatch).not.toHaveBeenCalled()
    await dispose()
  })

  it.each(['input', 'route', 'dispose', 'expiry', 'editor'])(
    'rejects late grants after %s changes',
    async (reason) => {
      const f = fixture()
      let release = (_response: unknown) => {}
      claim.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve
          })
      )
      const dispose = await setup(f.ctx)
      await vi.advanceTimersByTimeAsync(100)
      await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1))
      if (reason === 'input') {
        f.input.emit('paste')
      }
      if (reason === 'route') {
        f.route.type = 'session'
      }
      if (reason === 'dispose') {
        await dispose()
      }
      if (reason === 'expiry') {
        f.memory.expiresAt = Date.now()
      }
      if (reason === 'editor') {
        f.ctx.renderer.currentFocusedEditor = new Editor()
      }
      release({ ok: true, json: async () => ({ allowed: true }) })
      await vi.advanceTimersByTimeAsync(500)
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(f.editor.plainText).toBe('')
      await dispose()
    }
  )

  it.each(['input', 'route', 'dispose'])(
    'ends delivery when %s changes during insertion',
    async (reason) => {
      const f = fixture()
      let dispose = async () => {}
      const insert = f.editor.insertText.bind(f.editor)
      vi.spyOn(f.editor, 'insertText').mockImplementation((text) => {
        expect(f.memory.settled).toBe(true)
        insert(text)
        if (reason === 'input') {
          f.input.emit('keypress')
        }
        if (reason === 'route') {
          f.route.type = 'session'
        }
        if (reason === 'dispose') {
          void dispose()
        }
      })
      dispose = await setup(f.ctx)
      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1))
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(f.memory.settled).toBe(true)
      await dispose()
    }
  )

  it.each(['allow', 'lost-response'])(
    'degrades safely against a legacy host with %s',
    async (reason) => {
      const claims = new OpenCodeStartupPromptClaims()
      claims.register('single-use-nonce', digest, () => ({
        freshSpawn: true,
        firstUserInputAt: null
      }))
      let lost = false
      claim.mockImplementation(async (_url, init) => {
        const body = JSON.parse(init.body)
        const allowed = claims.claim({ nonce: body.nonce, digest: body.digest })
        if (reason === 'lost-response' && !lost) {
          lost = true
          throw new Error('legacy grant response lost')
        }
        return { ok: true, json: async () => ({ allowed }) }
      })
      const f = fixture()
      const dispose = await setup(f.ctx)
      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => expect(f.memory.settled).toBe(true))
      expect(f.dispatch).toHaveBeenCalledTimes(reason === 'allow' ? 1 : 0)
      expect(claim).toHaveBeenCalledTimes(reason === 'allow' ? 1 : 2)
      expect(f.editor.plainText).toBe('')
      claims.clear()
      await dispose()
    }
  )
})
