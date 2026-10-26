import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { buildBody, PANE } from '../agent-hooks/server.test-fixtures'
import { bindJcodeRootSession } from '../../shared/agent-hook-listener/jcode-session-registry'
import {
  displayMetadata,
  displayRootId,
  displayWorkerId,
  pigletTurn
} from '../../shared/agent-hook-listener-jcode-display-fixtures'
import { buildJcodeRuntimeDir, shouldInjectJcodeRuntimeDir } from '../../shared/jcode-runtime-dir'
import type { JcodeSpawnRequest } from '../../shared/jcode-spawn-hook'
import type { TerminalCreateOptions } from '../runtime/runtime-terminal-contracts'
import { RuntimeExternalParentLinks } from '../runtime/runtime-external-parent-links'
import {
  forgetJcodePaneSecret,
  mintJcodePaneSecret,
  verifyJcodePaneSecret
} from './jcode-pane-secrets'
import { createJcodeSpawnHandler, type JcodeSpawnHandlerDeps } from './jcode-spawn-tabs'

const command =
  "'/home/user/.local/bin/jcode' '--fresh-spawn' '--provider' 'claude' '--resume' 'session_piglet_1792604760697_211acdce5650ace5'"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

class SpawnServer extends AgentHookServer {
  acceptTurn() {
    this.ingestJcodeHook(buildBody(pigletTurn))
  }
}

function harness() {
  const server = new SpawnServer()
  bindJcodeRootSession(server._getStateForTests(), PANE, displayRootId, 'launch')
  const request: JcodeSpawnRequest = {
    paneKey: PANE,
    paneSecret: mintJcodePaneSecret(PANE),
    worktreeId: 'wt-1',
    kind: 'swarm-agent',
    command,
    sessionId: displayWorkerId,
    coordinatorSessionId: displayRootId,
    title: '🐽 jcode/castle Piglet',
    cwd: join(tmpdir(), 'jcode-workspace', 'src'),
    runtimeDir: buildJcodeRuntimeDir(PANE)
  }
  const links = new RuntimeExternalParentLinks()
  const tabs = new Map<string, string>([[PANE, 'root-handle']])
  const started = deferred<void>()
  let completion: Promise<{ handle: string }> | undefined
  const runtime = {
    hasLiveTerminalForPaneKey: vi.fn((key: string) => tabs.has(key)),
    getTerminalHandleForPaneKey: vi.fn((key: string) => tabs.get(key) ?? null),
    getTerminalWorktreeIdForHandle: vi.fn((handle: string): string | null =>
      [...tabs.values()].includes(handle) ? 'wt-1' : null
    ),
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      path: join(tmpdir(), 'jcode-workspace')
    })),
    focusTerminal: vi.fn(async () => {}),
    setExternalAgentParentLink: vi.fn((key, link) => links.set(key, link)),
    clearExternalAgentParentLink: vi.fn((key) => links.delete(key)),
    createTerminal: vi.fn(async (_selector: string, opts: TerminalCreateOptions) => {
      started.resolve()
      const result = await (completion ?? Promise.resolve({ handle: randomUUID() }))
      tabs.set(`${opts.tabId}:${opts.leafId}`, result.handle)
      return result
    }),
    closeTerminalTab: vi.fn(async (handle: string) => {
      for (const [key, value] of tabs) {
        if (value === handle) {
          tabs.delete(key)
        }
      }
    })
  } satisfies JcodeSpawnHandlerDeps['runtime']
  const reserve = vi.spyOn(server, 'reserveJcodeSessionTab')
  const bind = vi.spyOn(server, 'bindJcodeDisplaySession')
  const confirm = vi.spyOn(server, 'confirmJcodeSessionTab')
  const handler = createJcodeSpawnHandler({ runtime, server, verifyJcodePaneSecret })
  function childKey() {
    return reserve.mock.calls[0][0].paneKey
  }
  function clean() {
    expect(server.findJcodeSessionOwner(request.sessionId)).toBeUndefined()
    expect(links.entries()).toEqual([])
    expect(
      [...server._getStateForTests().jcodeDisplayBindings.values()].every(
        (entry) => entry.state === 'closed'
      )
    ).toBe(true)
    expect([...tabs.keys()]).toEqual([PANE])
  }
  async function run(req = request, signal = new AbortController().signal) {
    const result = await handler(req, signal)
    if (result === 'done') {
      expect(server.findJcodeSessionOwner(req.sessionId)?.state).toBe('open')
      if (runtime.focusTerminal.mock.calls.length === 0) {
        expect(confirm.mock.results.at(-1)?.value).toBe(true)
      }
    }
    return result
  }
  async function waitForCreate(result: Promise<unknown>) {
    await Promise.race([
      started.promise,
      result.then(() => {
        throw new Error('creation did not start')
      })
    ])
  }
  return {
    server,
    request,
    runtime,
    tabs,
    links,
    handler,
    run,
    reserve,
    bind,
    confirm,
    waitForCreate,
    childKey,
    clean,
    defer: (promise: Promise<{ handle: string }>) => {
      completion = promise
    }
  }
}

describe('Jcode spawn tab ownership', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-spawn-tabs-'))
    const home = join(dir, 'jcode')
    vi.stubEnv('JCODE_HOME', home)
    mkdirSync(join(home, 'sessions'), { recursive: true })
    for (const data of displayMetadata) {
      writeFileSync(join(home, 'sessions', `${data.id}.json`), JSON.stringify(data))
    }
  })
  afterEach(() => {
    forgetJcodePaneSecret(PANE)
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    'wrong secret',
    'stale secret',
    'unknown pane',
    'dead pane',
    'no workspace',
    'cross workspace',
    'missing workspace',
    'runtime dir',
    'stale alias'
  ])('rejects authority: %s', async (negative) => {
    const h = harness()
    if (negative === 'wrong secret') {
      h.request.paneSecret = randomUUID()
    }
    if (negative === 'stale secret') {
      mintJcodePaneSecret(PANE)
    }
    if (negative === 'unknown pane' || negative === 'stale alias') {
      h.tabs.delete(PANE)
    }
    if (negative === 'stale alias') {
      const moved = 'moved:33333333-3333-4333-8333-333333333333'
      h.server.transferPaneAuthority(PANE, moved)
      h.tabs.set(moved, 'moved-handle')
      expect(h.server.resolvePaneAuthorityOwner(PANE)).toBe(moved)
    }
    if (negative === 'dead pane') {
      h.runtime.hasLiveTerminalForPaneKey.mockReturnValue(false)
    }
    if (negative === 'no workspace') {
      h.runtime.getTerminalWorktreeIdForHandle.mockReturnValue(null)
    }
    if (negative === 'cross workspace') {
      h.request.worktreeId = 'wt-2'
    }
    if (negative === 'missing workspace') {
      h.request.worktreeId = undefined
    }
    if (negative === 'runtime dir') {
      vi.stubGlobal(
        'process',
        Object.defineProperty(Object.create(process), 'platform', { value: 'linux' })
      )
      h.request.runtimeDir = join(dir, 'foreign')
    }
    try {
      expect(await h.run()).toBe('forbidden')
      expect(h.runtime.createTerminal).not.toHaveBeenCalled()
      expect(h.runtime.focusTerminal).not.toHaveBeenCalled()
      expect(h.reserve).not.toHaveBeenCalled()
      expect(h.bind).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('binds and links before creation; real host accepts root-posted piglet on display pane', async () => {
    const h = harness()
    h.runtime.createTerminal.mockImplementationOnce(async (_selector, opts) => {
      expect(h.bind).toHaveBeenCalledOnce()
      expect(h.links.entries()[0]?.[0]).toBe(h.childKey())
      h.server.acceptTurn()
      h.tabs.set(h.childKey(), 'child')
      expect(opts.command).toBe(command)
      return { handle: 'child' }
    })
    expect(await h.run()).toBe('done')
    const opts = h.runtime.createTerminal.mock.calls[0][1]
    expect(opts).toMatchObject({
      title: h.request.title,
      surfaceOwner: false,
      command,
      jcodeRuntimeDir: shouldInjectJcodeRuntimeDir(process.platform)
        ? buildJcodeRuntimeDir(PANE)
        : undefined
    })
    expect(opts).not.toHaveProperty('launchAgent')
    expect(opts).not.toHaveProperty('launchToken')
    expect(`${opts.tabId}:${opts.leafId}`).toBe(h.childKey())
    expect(h.reserve.mock.invocationCallOrder[0]).toBeLessThan(h.bind.mock.invocationCallOrder[0])
    expect(h.bind.mock.invocationCallOrder[0]).toBeLessThan(
      h.runtime.setExternalAgentParentLink.mock.invocationCallOrder[0]
    )
    expect(h.runtime.setExternalAgentParentLink.mock.invocationCallOrder[0]).toBeLessThan(
      h.runtime.createTerminal.mock.invocationCallOrder[0]
    )
    expect(h.links.entries()).toEqual([
      [
        h.childKey(),
        { parentPaneKey: PANE, taskId: `jcode-spawn:${displayWorkerId}`, displayName: 'Piglet' }
      ]
    ])
    const binding = [...h.server._getStateForTests().jcodeDisplayBindings.values()][0]
    expect(binding.launchToken).toBeUndefined()
    expect(h.server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: h.childKey(),
        state: 'working',
        providerSession: { key: 'session_id', id: displayWorkerId }
      })
    ])
    expect(h.server._getStateForTests().jcodeSessions.roots.get(PANE)).toBe(displayRootId)
  })

  it.each(['resume', 'foreign coordinator', 'unknown root', 'refused binding'])(
    'opens plain for %s and later focuses same owner',
    async (path) => {
      const h = harness()
      if (path === 'resume') {
        h.request.kind = 'resume'
      }
      if (path === 'foreign coordinator') {
        h.request.coordinatorSessionId = 'session_nested'
      }
      if (path === 'unknown root') {
        h.server._getStateForTests().jcodeSessions.roots.delete(PANE)
      }
      if (path === 'refused binding') {
        h.bind.mockReturnValue(false)
      }
      expect(await h.run()).toBe('done')
      expect(h.server.findJcodeSessionOwner(displayWorkerId)).toMatchObject({
        role: 'plain',
        state: 'open'
      })
      expect(h.runtime.createTerminal.mock.calls[0][1]).not.toHaveProperty('launchAgent')
      expect(h.runtime.createTerminal.mock.calls[0][1]).not.toHaveProperty('launchToken')
      expect(h.links.entries()).toEqual([])
      expect(h.server._getStateForTests().jcodeDisplayBindings.size).toBe(0)
      expect(await h.run()).toBe('done')
      expect(h.runtime.createTerminal).toHaveBeenCalledOnce()
      expect(h.runtime.focusTerminal).toHaveBeenCalledOnce()
    }
  )

  it('focuses root resume without reservation', async () => {
    const h = harness()
    h.request.kind = 'resume'
    h.request.sessionId = displayRootId
    expect(await h.run()).toBe('done')
    expect(h.runtime.focusTerminal).toHaveBeenCalledWith('root-handle', expect.anything())
    expect(h.reserve).not.toHaveBeenCalled()
  })

  it('serializes concurrent resume creation and focuses after confirmation', async () => {
    const h = harness()
    h.request.kind = 'resume'
    const pending = deferred<{ handle: string }>()
    h.defer(pending.promise)
    const first = h.run()
    await h.waitForCreate(first)
    const second = h.run()
    expect(h.runtime.createTerminal).toHaveBeenCalledOnce()
    expect(h.runtime.focusTerminal).not.toHaveBeenCalled()
    pending.resolve({ handle: 'child' })
    expect(await Promise.all([first, second])).toEqual(['done', 'done'])
    expect(h.runtime.createTerminal).toHaveBeenCalledOnce()
    expect(h.runtime.focusTerminal).toHaveBeenCalledOnce()
  })

  it('fails waiter on its own abort without cancelling creator', async () => {
    const h = harness()
    const pending = deferred<{ handle: string }>()
    h.defer(pending.promise)
    const first = h.run()
    await h.waitForCreate(first)
    const controller = new AbortController()
    const second = h.run(h.request, controller.signal)
    controller.abort('deadline')
    expect(await second).toBe('failed')
    expect(h.runtime.focusTerminal).not.toHaveBeenCalled()
    pending.resolve({ handle: 'child' })
    expect(await first).toBe('done')
  })

  it('fails creator and parked waiter, then permits one replacement', async () => {
    const h = harness()
    const pending = deferred<{ handle: string }>()
    h.defer(pending.promise)
    const first = h.run()
    await h.waitForCreate(first)
    const second = h.run()
    pending.reject(new Error('create failed'))
    expect(await Promise.all([first, second])).toEqual(['failed', 'failed'])
    expect(h.runtime.focusTerminal).not.toHaveBeenCalled()
    h.defer(Promise.resolve({ handle: 'replacement' }))
    expect(await h.run()).toBe('done')
    expect(h.runtime.createTerminal).toHaveBeenCalledTimes(2)
  })

  it('rejects focusing an owner in another worktree', async () => {
    const h = harness()
    expect(await h.run()).toBe('done')
    h.runtime.getTerminalWorktreeIdForHandle.mockImplementation((handle) =>
      handle === 'root-handle' ? 'wt-1' : 'wt-2'
    )
    expect(await h.run()).toBe('failed')
    expect(h.runtime.focusTerminal).not.toHaveBeenCalled()
    expect(h.runtime.createTerminal).toHaveBeenCalledOnce()
  })

  it('rolls back a throwing success callback, wakes waiter and clears in-flight creation', async () => {
    const h = harness()
    const pending = deferred<{ handle: string }>()
    h.defer(pending.promise)
    h.confirm.mockImplementationOnce(() => {
      throw new Error('confirmation failed')
    })
    const first = h.run()
    await h.waitForCreate(first)
    const second = h.run()
    pending.resolve({ handle: 'unconfirmed' })
    expect(await Promise.all([first, second])).toEqual(['failed', 'failed'])
    h.clean()
    expect(h.runtime.closeTerminalTab).toHaveBeenCalledExactlyOnceWith('unconfirmed')
    h.defer(Promise.resolve({ handle: 'replacement' }))
    expect(await h.run()).toBe('done')
    expect(h.runtime.createTerminal).toHaveBeenCalledTimes(2)
  })

  it('extracts child display name from an activity title', async () => {
    const h = harness()
    h.request.title = '🌐 jcode/castle Piglet · work ~12s'
    expect(await h.run()).toBe('done')
    expect(h.links.entries()[0]?.[1].displayName).toBe('Piglet')
    expect(h.runtime.createTerminal.mock.calls[0][1].title).toBe(h.request.title)
  })

  it.each(['plain', 'worker'])(
    'rejects destination retirement during %s creation',
    async (kind) => {
      const h = harness()
      if (kind === 'plain') {
        h.request.kind = 'resume'
      }
      const pending = deferred<{ handle: string }>()
      h.defer(pending.promise)
      const result = h.run()
      await h.waitForCreate(result)
      h.server.closeJcodeSessionTab(h.childKey())
      pending.resolve({ handle: 'retired' })
      expect(await result).toBe('failed')
      expect(h.confirm.mock.results.at(-1)?.value).toBe(false)
      expect(h.runtime.closeTerminalTab).toHaveBeenCalledExactlyOnceWith('retired')
      h.clean()
    }
  )

  it('fails focus when owner retires during focus', async () => {
    const h = harness()
    expect(await h.run()).toBe('done')
    h.runtime.focusTerminal.mockImplementationOnce(async () => {
      h.server.closeJcodeSessionTab(h.childKey())
      h.server.settleJcodeDisplayPane(h.childKey())
    })
    expect(await h.run()).toBe('failed')
  })

  it.each(['deadline', 'client_disconnected'])(
    'rolls back %s immediately and closes late completion once',
    async (reason) => {
      const h = harness()
      const pending = deferred<{ handle: string }>()
      h.defer(pending.promise)
      const controller = new AbortController()
      const result = h.run(h.request, controller.signal)
      await h.waitForCreate(result)
      expect(h.runtime.createTerminal.mock.calls[0][1].signal).toBe(controller.signal)
      controller.abort(reason)
      expect(await result).toBe('failed')
      h.clean()
      pending.resolve({ handle: 'late' })
      await pending.promise
      await Promise.resolve()
      await Promise.resolve()
      expect(h.runtime.closeTerminalTab).toHaveBeenCalledExactlyOnceWith('late')
      expect(h.confirm).not.toHaveBeenCalled()
      h.clean()
    }
  )

  it('completion before disconnect keeps one confirmed tab', async () => {
    const h = harness()
    const controller = new AbortController()
    expect(await h.run(h.request, controller.signal)).toBe('done')
    controller.abort('client_disconnected')
    expect(h.tabs.size).toBe(2)
    expect(h.runtime.closeTerminalTab).not.toHaveBeenCalled()
  })

  it.each(['rejection', 'root retirement'])('rolls back creation after %s', async (failure) => {
    const h = harness()
    const pending = deferred<{ handle: string }>()
    h.defer(pending.promise)
    const result = h.run()
    await h.waitForCreate(result)
    if (failure === 'rejection') {
      pending.reject(new Error('create failed'))
    } else {
      forgetJcodePaneSecret(PANE)
      pending.resolve({ handle: 'orphan' })
    }
    expect(await result).toBe('failed')
    expect(h.confirm).not.toHaveBeenCalled()
    h.clean()
    expect(h.runtime.closeTerminalTab).toHaveBeenCalledTimes(failure === 'rejection' ? 0 : 1)
  })

  it('fails capacity refusal without focusing never-created pane', async () => {
    const h = harness()
    for (let i = 0; i < 256; i += 1) {
      expect(
        h.server.reserveJcodeSessionTab({
          sessionId: `session_capacity_${i}`,
          paneKey: `capacity-${i}:11111111-1111-4111-8111-111111111111`,
          rootPaneKey: PANE,
          kind: 'plain'
        }).ok
      ).toBe(true)
    }
    expect(await h.run()).toBe('failed')
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
    expect(h.runtime.focusTerminal).not.toHaveBeenCalled()
  })

  it('focuses live winner of reservation race', async () => {
    const h = harness()
    h.reserve.mockImplementationOnce(() => ({
      ok: false,
      owner: {
        sessionId: displayWorkerId,
        paneKey: PANE,
        rootPaneKey: PANE,
        kind: 'plain',
        state: 'open'
      }
    }))
    vi.spyOn(h.server, 'findJcodeSessionOwner')
      .mockReturnValueOnce(undefined)
      .mockReturnValue({ paneKey: PANE, role: 'plain', state: 'open' })
    expect(await h.run()).toBe('done')
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
    expect(h.runtime.focusTerminal).toHaveBeenCalledOnce()
  })

  it.each(['inside', 'outside', 'traversal'])('constrains child cwd: %s', async (path) => {
    const h = harness()
    if (path === 'outside') {
      h.request.cwd = join(tmpdir(), 'jcode-workspace-other')
    }
    if (path === 'traversal') {
      h.request.cwd = join(tmpdir(), 'jcode-workspace', '..', 'other')
    }
    expect(await h.run()).toBe('done')
    expect(h.runtime.createTerminal.mock.calls[0][1].cwd).toBe(
      path === 'inside' ? h.request.cwd : undefined
    )
  })

  it('omits runtime directory on Windows', async () => {
    vi.stubGlobal(
      'process',
      Object.defineProperty(Object.create(process), 'platform', { value: 'win32' })
    )
    try {
      const h = harness()
      h.request.runtimeDir = undefined
      expect(await h.run()).toBe('done')
      expect(h.runtime.createTerminal.mock.calls[0][1].jcodeRuntimeDir).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
