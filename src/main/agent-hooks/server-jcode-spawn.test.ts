import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, type JcodeSpawnOutcome } from './server'
import { GOOD_PANE, PANE } from './server.test-fixtures'
import {
  JCODE_SPAWN_CREATE_BUDGET_MS,
  JCODE_SPAWN_HOOK_PATHNAME,
  type JcodeSpawnRequest
} from '../../shared/jcode-spawn-hook'

const rootSessionId = 'session_pawprint_1792604760602_81cf383ab5bbf2d4'
const sessionId = 'session_piglet_1792604760697_211acdce5650ace5'

describe('Jcode spawn HTTP acceptance', () => {
  let dir: string
  let server: AgentHookServer
  let form: Record<string, string>
  let transport: Record<string, string>
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jcode-main-spawn-'))
    vi.stubEnv('JCODE_HOME', join(dir, 'jcode'))
    server = new AgentHookServer()
    await server.start({ userDataPath: dir, env: 'production' })
    transport = server.buildPtyEnv()
    form = {
      paneKey: PANE,
      paneSecret: randomUUID(),
      worktreeId: 'wt-1',
      kind: 'swarm-agent',
      sessionId,
      coordinatorSessionId: rootSessionId,
      title: '🐽 jcode/castle Piglet',
      command:
        "'/home/user/.local/bin/jcode' '--fresh-spawn' '--provider' 'claude' '--resume' 'session_piglet_1792604760697_211acdce5650ace5'",
      cwd: join(dir, 'cwd'),
      runtimeDir: join(dir, 'runtime')
    }
  })
  afterEach(() => {
    server.stop()
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  function post(body = new URLSearchParams(form).toString(), token?: string, json = false) {
    const env = transport
    const client = httpRequest({
      host: '127.0.0.1',
      port: Number(env.ORCA_AGENT_HOOK_PORT),
      path: JCODE_SPAWN_HOOK_PATHNAME,
      method: 'POST',
      headers: {
        'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded',
        Connection: 'close',
        'X-Orca-Agent-Hook-Token': token ?? env.ORCA_AGENT_HOOK_TOKEN
      }
    })
    const response = new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        client.on('error', reject)
        client.on('response', (res) => {
          let content = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            content += chunk
          })
          res.on('error', reject)
          res.on('end', () => resolve({ status: res.statusCode, body: content }))
        })
      }
    )
    client.end(body)
    return { client, response }
  }

  it('decodes the captured piglet form once without altering text', async () => {
    let calls = 0
    server.setJcodeSpawnListener(async (request, signal) => {
      calls++
      expect(
        Object.entries(form).every(([key, value]) => Reflect.get(request, key) === value)
      ).toBe(true)
      expect(signal.aborted).toBe(false)
      return 'done'
    })
    expect(await post().response).toEqual({ status: 200, body: '{"ok":true}' })
    expect(calls).toBe(1)
  })

  it('accepts older scripts and ignores obsolete fields before dispatch', async () => {
    form.tabId = 'old-tab'
    form.launchToken = randomUUID()
    server.setJcodeSpawnListener(async (request) => {
      expect('tabId' in request || 'launchToken' in request).toBe(false)
      return 'done'
    })
    expect((await post().response).status).toBe(200)
  })

  it('round-trips form title spaces, plus, ampersand, percent and emoji', async () => {
    // Negative control: punctuation added to the captured title, encoded like curl --data-urlencode.
    form.title += ' + & 100%'
    let title: string | undefined
    server.setJcodeSpawnListener(async (request) => {
      title = request.title
      return 'done'
    })
    const encoded = Object.entries(form)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&')
    expect((await post(encoded).response).status).toBe(200)
    expect(title).toBe(form.title)
  })

  it.each<{ outcome: JcodeSpawnOutcome; status: number }>([
    { outcome: 'done', status: 200 },
    { outcome: 'forbidden', status: 403 },
    { outcome: 'failed', status: 503 }
  ])('maps $outcome to $status', async ({ outcome, status }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    server.setJcodeSpawnListener(async () => outcome)
    const result = await post().response
    expect(result.status).toBe(status)
    expect(vi.getTimerCount()).toBe(0)
    if (status !== 200) {
      expect(result.body).toBe('')
    }
  })

  it('rejects a wrong app token before dispatch', async () => {
    const listener = vi.fn(async (): Promise<JcodeSpawnOutcome> => 'done')
    server.setJcodeSpawnListener(listener)
    expect(await post(undefined, randomUUID()).response).toEqual({ status: 403, body: '' })
    expect(listener).not.toHaveBeenCalled()
  })

  it.each(['pane', 'authority', 'json'] as const)(
    'rejects malformed %s before dispatch',
    async (kind) => {
      const listener = vi.fn(async (): Promise<JcodeSpawnOutcome> => 'done')
      server.setJcodeSpawnListener(listener)
      // Negative controls against the captured form.
      if (kind === 'pane') {
        form.paneKey = 'capture-test2'
      }
      if (kind === 'authority') {
        delete form.paneSecret
      }
      const result = await post(kind === 'json' ? '{' : undefined, undefined, kind === 'json')
        .response
      expect(result).toEqual({ status: 400, body: '' })
      expect(listener).not.toHaveBeenCalled()
    }
  )

  it.each(['throw', 'reject'] as const)(
    'returns 503 on listener %s without exposing fields',
    async (kind) => {
      server.setJcodeSpawnListener(() => {
        if (kind === 'throw') {
          throw new Error('creation failed')
        }
        return Promise.reject(new Error('creation failed'))
      })
      expect(await post().response).toEqual({ status: 503, body: '' })
    }
  )

  it('fails when no listener is installed or listener was cleared', async () => {
    expect(await post().response).toEqual({ status: 503, body: '' })
    server.setJcodeSpawnListener(async () => 'done')
    server.setJcodeSpawnListener(null)
    expect(await post().response).toEqual({ status: 503, body: '' })
  })

  it('dispatches while status hooks are disabled', async () => {
    await server.start({ statusHooksEnabled: false })
    server.setJcodeSpawnListener(async () => 'done')
    expect((await post().response).status).toBe(200)
  })

  it('clears the spawn listener on stop', async () => {
    server.setJcodeSpawnListener(async () => 'done')
    server.stop()
    await server.start({ userDataPath: dir })
    transport = server.buildPtyEnv()
    server.setStatusHooksEnabled(false)
    expect((await post().response).status).toBe(503)
  })

  function pendingListener() {
    const entered = Promise.withResolvers<AbortSignal>()
    const finished = Promise.withResolvers<JcodeSpawnOutcome>()
    server.setJcodeSpawnListener((_request: JcodeSpawnRequest, signal) => {
      entered.resolve(signal)
      return finished.promise
    })
    return { entered: entered.promise, finish: finished.resolve }
  }

  it('answers 503 at the deadline without waiting and ignores late success', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = pendingListener()
    const http = post()
    const signal = await pending.entered
    const writeHead = vi.spyOn(ServerResponse.prototype, 'writeHead')
    expect(JCODE_SPAWN_CREATE_BUDGET_MS).toBe(1000)
    await vi.advanceTimersByTimeAsync(JCODE_SPAWN_CREATE_BUDGET_MS - 1)
    expect(signal.aborted).toBe(false)
    expect(writeHead).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe('deadline')
    expect(await http.response).toEqual({ status: 503, body: '' })
    pending.finish('done')
    await vi.advanceTimersByTimeAsync(JCODE_SPAWN_CREATE_BUDGET_MS)
    expect(writeHead.mock.calls).toEqual([[503]])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['done', 'reject'] as const)('aborts on disconnect and ignores late %s', async (late) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const entered = Promise.withResolvers<AbortSignal>()
    const finished = Promise.withResolvers<JcodeSpawnOutcome>()
    server.setJcodeSpawnListener((_request, signal) => {
      entered.resolve(signal)
      return finished.promise
    })
    const http = post()
    const disconnected = http.response.catch(() => null)
    const signal = await entered.promise
    const aborted = new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true })
    )
    const writeHead = vi.spyOn(ServerResponse.prototype, 'writeHead')
    http.client.destroy()
    await aborted
    expect(signal.reason).toBe('client_disconnected')
    expect(await disconnected).toBeNull()
    if (late === 'done') {
      finished.resolve('done')
    } else {
      finished.reject(new Error('creation failed'))
    }
    await vi.advanceTimersByTimeAsync(JCODE_SPAWN_CREATE_BUDGET_MS)
    expect(writeHead).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('writes nothing when the server stops during creation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = pendingListener()
    const http = post()
    const disconnected = http.response.catch(() => null)
    const signal = await pending.entered
    const writeHead = vi.spyOn(ServerResponse.prototype, 'writeHead')
    server.stop()
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe('stopped')
    expect(Reflect.get(server, 'jcodeSpawns')).toEqual(new Set())
    expect(await disconnected).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    pending.finish('done')
    await vi.advanceTimersByTimeAsync(JCODE_SPAWN_CREATE_BUDGET_MS)
    expect(writeHead).not.toHaveBeenCalled()
  })

  it('exposes registry ownership and display lifecycle through the server', () => {
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'jcode',
      providerSession: { key: 'session_id', id: rootSessionId },
      launchedAt: Date.now()
    })
    expect(server.rootJcodeSessionId(PANE)).toBe(rootSessionId)
    expect(server.findJcodeSessionOwner(rootSessionId)).toEqual({
      paneKey: PANE,
      role: 'root',
      state: 'open'
    })
    const owner = { paneKey: GOOD_PANE, sessionId, rootPaneKey: PANE, kind: 'worker' as const }
    expect(server.reserveJcodeSessionTab(owner)).toEqual({ ok: true })
    expect(server.findJcodeSessionOwner(sessionId)).toEqual({
      paneKey: GOOD_PANE,
      role: 'worker',
      state: 'creating'
    })
    const binding = {
      rootPaneKey: PANE,
      displayPaneKey: GOOD_PANE,
      sessionId,
      coordinatorSessionId: rootSessionId,
      tabId: 'tab-good',
      state: 'open' as const,
      boundAt: Date.now()
    }
    expect(server.bindJcodeDisplaySession(binding)).toBe(true)
    expect(server.confirmJcodeSessionTab(sessionId, GOOD_PANE)).toBe(true)
    expect(server.findJcodeSessionOwner(sessionId)?.state).toBe('open')
    expect(server.jcodeDisplayPanesOfRoot(PANE)).toEqual([GOOD_PANE])
    expect(server.settleJcodeDisplayPane(GOOD_PANE)).toBe(true)
    server.closeJcodeSessionTab(GOOD_PANE)
    expect(server.findJcodeSessionOwner(sessionId)).toBeUndefined()
    server.clearJcodeDisplayBindingsOfRoot(PANE)
    expect(server.reserveJcodeSessionTab(owner)).toEqual({ ok: true })
    expect(server.bindJcodeDisplaySession(binding)).toBe(true)
    server.releaseJcodeSessionTab(sessionId, GOOD_PANE)
    expect(server.findJcodeSessionOwner(sessionId)).toBeUndefined()
    expect(server.jcodeDisplayPanesOfRoot(PANE)).toEqual([])
    expect(server.reserveJcodeSessionTab({ ...owner, kind: 'plain' })).toEqual({ ok: true })
    expect(server.closeJcodeSessionTab(GOOD_PANE)).toEqual([sessionId])
    expect(server.findJcodeSessionOwner(sessionId)).toBeUndefined()
  })
})
