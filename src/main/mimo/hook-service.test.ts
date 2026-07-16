import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { MimoCodeHookService, _internals } from './hook-service'

describe('MimoCodeHookService buildPtyEnv', () => {
  let userDataDir: string
  let mimocodeHome: string

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-mimocode-userdata-'))
    getPathMock.mockImplementation((name) => {
      if (name === 'userData') {
        return userDataDir
      }
      throw new Error(`unexpected getPath: ${name}`)
    })

    mimocodeHome = mkdtempSync(join(tmpdir(), 'orca-mimocode-home-'))
    const configDir = join(mimocodeHome, 'config')
    mkdirSync(join(configDir, 'plugins'), { recursive: true })
    writeFileSync(join(configDir, 'mimocode.json'), '{"theme":"dark"}')
    writeFileSync(join(configDir, 'plugins', 'user-plugin.js'), 'export default () => {}')
    writeFileSync(join(configDir, 'plugins', 'orca-mimocode-status.js'), 'USER PLUGIN')
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(mimocodeHome, { recursive: true, force: true })
  })

  it('mirrors user config into shared overlay and installs Orca status plugin', () => {
    const service = new MimoCodeHookService()
    const env = service.buildPtyEnv('pty-1', mimocodeHome)

    const overlayHome = join(userDataDir, 'mimocode-hooks', 'shared')
    expect(env.MIMOCODE_HOME).toBe(overlayHome)
    expect(readFileSync(join(overlayHome, 'config', 'mimocode.json'), 'utf8')).toBe(
      '{"theme":"dark"}'
    )
    expect(readFileSync(join(overlayHome, 'config', 'plugins', 'user-plugin.js'), 'utf8')).toBe(
      'export default () => {}'
    )

    const orcaPlugin = join(overlayHome, 'config', 'plugins', 'orca-mimocode-status.js')
    expect(existsSync(orcaPlugin)).toBe(true)
    expect(readFileSync(orcaPlugin, 'utf8')).toContain('/hook/mimo-code')

    expect(
      readFileSync(join(mimocodeHome, 'config', 'plugins', 'orca-mimocode-status.js'), 'utf8')
    ).toBe('USER PLUGIN')
  })

  it('reuses the overlay home on a second buildPtyEnv call', () => {
    const service = new MimoCodeHookService()
    const first = service.buildPtyEnv('pty-1', mimocodeHome)
    const second = service.buildPtyEnv('pty-2', mimocodeHome)

    const overlayHome = join(userDataDir, 'mimocode-hooks', 'shared')
    expect(first.MIMOCODE_HOME).toBe(overlayHome)
    expect(second.MIMOCODE_HOME).toBe(overlayHome)
    expect(
      readFileSync(join(overlayHome, 'config', 'plugins', 'orca-mimocode-status.js'), 'utf8')
    ).toContain('/hook/mimo-code')
  })
})

type RecordedPost = {
  url: string
  body: {
    paneKey: string
    payload: {
      hook_event_name: string
      sessionID?: string
      agent_id?: string
      agent_type?: string
      description?: string
    }
  }
}

type PluginEventHandler = (input: { event: unknown }) => Promise<void>

const HOOK_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENDPOINT'
] as const

describe('MiMo generated plugin actor lifecycle', () => {
  let tempDir: string
  let posts: RecordedPost[]
  let savedEnv: Record<string, string | undefined>
  let savedFetch: typeof globalThis.fetch

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-mimo-plugin-test-'))
    posts = []
    savedEnv = {}
    for (const key of HOOK_ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    process.env.ORCA_PANE_KEY = 'tab-1:mimo-leaf'
    process.env.ORCA_AGENT_HOOK_PORT = '45679'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    savedFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(null, { status: 204 })
    }) as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = savedFetch
    for (const key of HOOK_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function loadPluginEventHandler(): Promise<PluginEventHandler> {
    const pluginPath = join(tempDir, 'orca-mimocode-status.mjs')
    writeFileSync(pluginPath, _internals.getMimoCodePluginSource())
    const module = (await import(pathToFileURL(pluginPath).href)) as {
      OrcaOpenCodeStatusPlugin: (ctx: unknown) => Promise<{ event: PluginEventHandler }>
    }
    const hooks = await module.OrcaOpenCodeStatusPlugin({
      client: {
        session: {
          list: async () => ({ data: [{ id: 'session-main' }, { id: 'session-other' }] })
        }
      }
    })
    return hooks.event
  }

  function registered(
    sessionID: string,
    actorID: string,
    mode: 'main' | 'peer' | 'subagent',
    extras: Record<string, unknown> = {}
  ): { event: unknown } {
    return {
      event: {
        type: 'actor.registered',
        properties: {
          sessionID,
          actorID,
          mode,
          agent: `${mode}-agent`,
          description: `${mode} work`,
          background: mode !== 'main',
          ...extras
        }
      }
    }
  }

  function actorStatus(
    sessionID: string,
    actorID: string,
    status: 'pending' | 'running' | 'idle',
    lastOutcome?: 'success' | 'failure' | 'cancelled'
  ): { event: unknown } {
    return {
      event: {
        type: 'actor.status',
        properties: {
          sessionID,
          actorID,
          status,
          ...(lastOutcome ? { lastOutcome } : {}),
          turnCount: 1,
          lastTurnTime: 100
        }
      }
    }
  }

  function lifecyclePosts(): RecordedPost[] {
    return posts.filter((post) =>
      ['SubagentStart', 'SubagentStop'].includes(post.body.payload.hook_event_name)
    )
  }

  function expectedAgentId(sessionID: string, actorID: string): string {
    const actorIdentity = `${sessionID.length}:${sessionID}${actorID.length}:${actorID}`
    const digest = createHash('sha256').update(`mimo\0${actorIdentity}`).digest('hex').slice(0, 32)
    return `mimo-${digest}`
  }

  it('uses the MiMo provider adapter in the installed runtime source', () => {
    const source = _internals.getMimoCodePluginSource()

    expect(source).toContain('const ORCA_CHILD_PROVIDER = "mimo";')
    expect(source).toContain('if (event.type === "actor.registered")')
    expect(source).toContain('if (event.type === "actor.status")')
    expect(source).toContain('/hook/mimo-code')
  })

  it('ignores main, tracks a non-main actor, and preserves root idle ordering', async () => {
    const handler = await loadPluginEventHandler()

    await handler(registered('session-main', 'main', 'main'))
    await handler(actorStatus('session-main', 'main', 'running'))
    await handler(
      registered('session-main', 'actor-review', 'subagent', {
        agent: 'reviewer',
        description: 'Review background change'
      })
    )
    await handler(actorStatus('session-main', 'actor-review', 'pending'))
    await handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'session-main', status: { type: 'busy' } }
      }
    })
    await handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'session-main', status: { type: 'idle' } }
      }
    })
    await handler(actorStatus('session-main', 'actor-review', 'running'))
    await handler(actorStatus('session-main', 'actor-review', 'idle', 'success'))
    await handler(actorStatus('session-main', 'actor-review', 'idle', 'success'))

    expect(posts.map((post) => post.body.payload.hook_event_name)).toEqual([
      'SubagentStart',
      'SessionBusy',
      'SessionIdle',
      'SubagentStop'
    ])
    expect(lifecyclePosts().map((post) => post.body.payload)).toEqual([
      {
        hook_event_name: 'SubagentStart',
        agent_id: expectedAgentId('session-main', 'actor-review'),
        agent_type: 'reviewer',
        description: 'Review background change'
      },
      {
        hook_event_name: 'SubagentStop',
        agent_id: expectedAgentId('session-main', 'actor-review'),
        agent_type: 'reviewer',
        description: 'Review background change'
      }
    ])
    expect(JSON.stringify(lifecyclePosts())).not.toContain('actor-review')
    expect(JSON.stringify(lifecyclePosts())).not.toContain('session-main')
  })

  it('retries non-2xx actor starts and re-announces them after an endpoint change', async () => {
    const handler = await loadPluginEventHandler()
    const attempts: { url: string; token: string; eventName: string }[] = []
    let attempt = 0
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      attempt += 1
      const body = JSON.parse(String(init?.body)) as RecordedPost['body']
      const headers = init?.headers as Record<string, string>
      attempts.push({
        url: String(url),
        token: headers['X-Orca-Agent-Hook-Token'],
        eventName: body.payload.hook_event_name
      })
      return new Response(null, { status: attempt === 1 ? 403 : 204 })
    }) as typeof globalThis.fetch
    const running = actorStatus('session-main', 'actor-retry', 'running')

    await handler(registered('session-main', 'actor-retry', 'subagent'))
    await handler(running)
    await handler(running)
    await handler(running)
    expect(attempts).toHaveLength(2)

    process.env.ORCA_AGENT_HOOK_PORT = '45681'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'replacement-token'
    await handler(running)
    await handler(running)
    await handler(actorStatus('session-main', 'actor-retry', 'idle', 'success'))

    expect(attempts).toEqual([
      {
        url: 'http://127.0.0.1:45679/hook/mimo-code',
        token: 'test-token',
        eventName: 'SubagentStart'
      },
      {
        url: 'http://127.0.0.1:45679/hook/mimo-code',
        token: 'test-token',
        eventName: 'SubagentStart'
      },
      {
        url: 'http://127.0.0.1:45681/hook/mimo-code',
        token: 'replacement-token',
        eventName: 'SubagentStart'
      },
      {
        url: 'http://127.0.0.1:45681/hook/mimo-code',
        token: 'replacement-token',
        eventName: 'SubagentStop'
      }
    ])
  })

  it('defers status-before-registration and starts only after non-main identity is known', async () => {
    const handler = await loadPluginEventHandler()

    await handler(actorStatus('session-main', 'late-actor', 'running'))
    expect(lifecyclePosts()).toHaveLength(0)
    await handler(
      registered('session-main', 'late-actor', 'peer', {
        agent: 'researcher',
        description: 'Late registration'
      })
    )
    await handler(actorStatus('session-main', 'late-actor', 'idle', 'cancelled'))

    await handler(actorStatus('session-main', 'late-main', 'running'))
    await handler(registered('session-main', 'late-main', 'main'))

    expect(lifecyclePosts().map((post) => post.body.payload.hook_event_name)).toEqual([
      'SubagentStart',
      'SubagentStop'
    ])
    expect(lifecyclePosts()[0].body.payload.agent_id).toBe(
      expectedAgentId('session-main', 'late-actor')
    )
  })

  it('tracks concurrent peer, nested subagent, and same actor ID in another session', async () => {
    const handler = await loadPluginEventHandler()
    const actors = [
      { sessionID: 'session-main', actorID: 'worker', mode: 'peer' as const },
      {
        sessionID: 'session-main',
        actorID: 'nested',
        mode: 'subagent' as const,
        parentActorID: 'worker'
      },
      { sessionID: 'session-other', actorID: 'worker', mode: 'subagent' as const }
    ]

    for (const actor of actors) {
      await handler(
        registered(
          actor.sessionID,
          actor.actorID,
          actor.mode,
          actor.parentActorID ? { parentActorID: actor.parentActorID } : {}
        )
      )
      await handler(actorStatus(actor.sessionID, actor.actorID, 'running'))
    }

    const startIds = lifecyclePosts()
      .filter((post) => post.body.payload.hook_event_name === 'SubagentStart')
      .map((post) => post.body.payload.agent_id)
    expect(startIds).toEqual([
      expectedAgentId('session-main', 'worker'),
      expectedAgentId('session-main', 'nested'),
      expectedAgentId('session-other', 'worker')
    ])
    expect(new Set(startIds).size).toBe(3)

    for (const [index, actor] of actors.entries()) {
      const outcome = (['success', 'failure', 'cancelled'] as const)[index]
      await handler(actorStatus(actor.sessionID, actor.actorID, 'idle', outcome))
    }
    expect(
      lifecyclePosts().filter((post) => post.body.payload.hook_event_name === 'SubagentStop')
    ).toHaveLength(3)
  })

  it('keeps crafted delimiter-bearing actor tuples collision-free', async () => {
    const handler = await loadPluginEventHandler()
    const actors = [
      { sessionID: 'tuple-a', actorID: 'tuple-b\0tuple-c' },
      { sessionID: 'tuple-a\0tuple-b', actorID: 'tuple-c' }
    ]

    for (const actor of actors) {
      await handler(registered(actor.sessionID, actor.actorID, 'subagent'))
      await handler(actorStatus(actor.sessionID, actor.actorID, 'running'))
    }

    const ids = lifecyclePosts()
      .filter((post) => post.body.payload.hook_event_name === 'SubagentStart')
      .map((post) => post.body.payload.agent_id)
    expect(ids).toEqual(actors.map((actor) => expectedAgentId(actor.sessionID, actor.actorID)))
    expect(new Set(ids).size).toBe(2)
  })

  it('tracks an actor when both identity components are at the maximum length', async () => {
    const handler = await loadPluginEventHandler()
    const sessionID = 's'.repeat(1024)
    const actorID = 'a'.repeat(1024)

    await handler(registered(sessionID, actorID, 'subagent'))
    await handler(actorStatus(sessionID, actorID, 'running'))
    await handler(actorStatus(sessionID, actorID, 'idle', 'success'))

    expect(lifecyclePosts().map((post) => post.body.payload)).toEqual([
      {
        hook_event_name: 'SubagentStart',
        agent_id: expectedAgentId(sessionID, actorID),
        agent_type: 'subagent-agent',
        description: 'subagent work'
      },
      {
        hook_event_name: 'SubagentStop',
        agent_id: expectedAgentId(sessionID, actorID),
        agent_type: 'subagent-agent',
        description: 'subagent work'
      }
    ])
  })

  it('drains all active actors for a deleted session exactly once', async () => {
    const handler = await loadPluginEventHandler()
    for (const actorID of ['delete-a', 'delete-b']) {
      await handler(registered('session-main', actorID, 'subagent'))
      await handler(actorStatus('session-main', actorID, 'running'))
    }

    const deleted = {
      event: { type: 'session.deleted', properties: { info: { id: 'session-main' } } }
    }
    await handler(deleted)
    await handler(deleted)

    expect(
      lifecyclePosts().filter((post) => post.body.payload.hook_event_name === 'SubagentStop')
    ).toHaveLength(2)
  })

  it('makes session deletion atomic against racing actor status and registration', async () => {
    const handler = await loadPluginEventHandler()
    for (const actorID of ['race-a', 'race-b']) {
      await handler(registered('session-main', actorID, 'subagent'))
      await handler(actorStatus('session-main', actorID, 'running'))
    }

    const delivered: string[] = []
    let releaseFirstStop!: () => void
    let stopCalls = 0
    const firstStopGate = new Promise<void>((resolve) => {
      releaseFirstStop = resolve
    })
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RecordedPost['body']
      const eventName = body.payload.hook_event_name
      if (eventName === 'SubagentStop') {
        stopCalls += 1
        if (stopCalls === 1) {
          await firstStopGate
        }
      }
      delivered.push(eventName)
      return new Response(null, { status: 204 })
    })
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    const deleting = handler({
      event: { type: 'session.deleted', properties: { info: { id: 'session-main' } } }
    })
    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve()
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const restarting = handler(actorStatus('session-main', 'race-a', 'running'))
    const registering = handler(registered('session-main', 'race-new', 'subagent'))
    const startingNew = handler(actorStatus('session-main', 'race-new', 'running'))
    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve()
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)

    releaseFirstStop()
    await Promise.all([deleting, restarting, registering, startingNew])
    await handler(actorStatus('session-main', 'race-a', 'running'))

    expect(delivered).toEqual(['SubagentStop', 'SubagentStop'])
  })

  it('ignores malformed or unregistered actor events while older root-only status still works', async () => {
    const handler = await loadPluginEventHandler()

    await handler({
      event: {
        type: 'actor.registered',
        properties: { sessionID: 'session-main', actorID: 'bad-mode', mode: 'other' }
      }
    })
    await handler(actorStatus('session-main', 'unknown-actor', 'running'))
    await handler({
      event: {
        type: 'actor.status',
        properties: {
          sessionID: 'session-main',
          actorID: 'bad-status',
          status: 'working',
          turnCount: 0,
          lastTurnTime: 0
        }
      }
    })
    await handler({
      event: {
        type: 'actor.status',
        properties: {
          sessionID: 'x'.repeat(1025),
          actorID: 'oversized',
          status: 'running'
        }
      }
    })
    await handler({
      event: {
        type: 'session.status',
        properties: { sessionID: 'session-main', status: { type: 'busy' } }
      }
    })
    await handler({
      event: { type: 'session.idle', properties: { sessionID: 'session-main' } }
    })

    expect(lifecyclePosts()).toHaveLength(0)
    expect(posts.map((post) => post.body.payload.hook_event_name)).toEqual([
      'SessionBusy',
      'SessionIdle'
    ])
  })
})
