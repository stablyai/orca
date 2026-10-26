import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentHookServer as server } from './server'
import type * as HookServerModule from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { bindJcodeRootSession } from '../../shared/agent-hook-listener/jcode-session-registry'
import { clearAllListenerCaches } from '../../shared/agent-hook-listener/listener-state'
import {
  displayMetadata,
  displayRootId,
  displayWorkerId,
  pawprintStart,
  pigletLateTool,
  pigletStart,
  pigletTurn
} from '../../shared/agent-hook-listener-jcode-display-fixtures'
import type { SpoolRecord } from '../../shared/agent-hook-spool'
import type { JcodeSpawnRequest } from '../../shared/jcode-spawn-hook'
import { buildJcodeRuntimeDir } from '../../shared/jcode-runtime-dir'
import { registerJcodeSpawnOwner, type JcodeSpawnHandlerDeps } from '../jcode/jcode-spawn-tabs'
import { retireJcodePane } from '../jcode/jcode-pane-retirement'
import {
  forgetJcodePaneSecret,
  mintJcodePaneSecret,
  verifyJcodePaneSecret
} from '../jcode/jcode-pane-secrets'
import { RuntimeExternalParentLinks } from '../runtime/runtime-external-parent-links'
import type { TerminalCreateOptions } from '../runtime/runtime-terminal-contracts'
import { paneKeyPtyId, paneKeyTeardownListeners, ptyPaneKey } from '../ipc/pty/pane/key-state'
import { clearProviderPtyState } from '../ipc/pty/provider/state-cleanup'

vi.mock('electron', () =>
  import('../ipc/pty-ipc-mock-registry').then((m) => m.electronModuleMock())
)
vi.mock('../opencode/hook-service', () => ({ openCodeHookService: { clearPty: vi.fn() } }))
vi.mock('../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { clearPty: vi.fn() }
}))
vi.mock('./server', async (importOriginal) => {
  const actual = await importOriginal<typeof HookServerModule>()
  class LifetimeServer extends actual.AgentHookServer {
    replay(record: SpoolRecord) {
      return this.ingestSpoolRecord(record)
    }
  }
  return { ...actual, agentHookServer: new LifetimeServer() }
})

describe('Jcode display lifetime at real PTY teardown', () => {
  let dir: string
  let request: JcodeSpawnRequest
  let runtime: ReturnType<typeof createRuntime>
  let listeners: Set<(key: string) => void>
  let completion: ReturnType<typeof Promise.withResolvers<{ handle: string }>> | undefined
  let started: ReturnType<typeof Promise.withResolvers<void>>
  const links = new RuntimeExternalParentLinks()
  const tabs = new Map<string, string>()
  const minted = new Set<string>()

  function attach(key: string) {
    const id = randomUUID()
    ptyPaneKey.set(id, key)
    paneKeyPtyId.set(key, id)
    return id
  }
  function retire(key: string) {
    const id = paneKeyPtyId.get(key)
    expect(id).toBeDefined()
    clearProviderPtyState(id!)
    tabs.delete(key)
  }
  function createRuntime() {
    return {
      hasLiveTerminalForPaneKey: (key: string) => tabs.has(key),
      getTerminalHandleForPaneKey: (key: string) => tabs.get(key) ?? null,
      getTerminalWorktreeIdForHandle: (handle: string) =>
        [...tabs.values()].includes(handle) ? 'wt-1' : null,
      resolveTerminalWorkspaceLaunchScope: async () => ({ path: dir }),
      focusTerminal: vi.fn(async () => {}),
      createTerminal: vi.fn(async (_selector: string, opts: TerminalCreateOptions) => {
        const key = `${opts.tabId}:${opts.leafId}`
        attach(key)
        mintJcodePaneSecret(key)
        minted.add(key)
        started.resolve()
        const terminal = await (completion?.promise ?? Promise.resolve({ handle: randomUUID() }))
        tabs.set(key, terminal.handle)
        return terminal
      }),
      closeTerminalTab: vi.fn(async (handle: string) => {
        const key = [...tabs].find(([, value]) => value === handle)?.[0]
        if (key) {
          if (paneKeyPtyId.has(key)) {
            retire(key)
          }
          tabs.delete(key)
        }
      }),
      setExternalAgentParentLink: (key, link) => links.set(key, link),
      clearExternalAgentParentLink: (key) => links.delete(key)
    } satisfies JcodeSpawnHandlerDeps['runtime']
  }
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jcode-lifetime-'))
    vi.stubEnv('JCODE_HOME', join(dir, 'jcode'))
    mkdirSync(join(dir, 'jcode', 'sessions'), { recursive: true })
    for (const metadata of displayMetadata) {
      writeFileSync(join(dir, 'jcode', 'sessions', `${metadata.id}.json`), JSON.stringify(metadata))
    }
    completion = undefined
    started = Promise.withResolvers<void>()
    listeners = new Set(paneKeyTeardownListeners)
    tabs.set(PANE, 'root')
    attach(PANE)
    minted.add(PANE)
    request = {
      paneKey: PANE,
      paneSecret: mintJcodePaneSecret(PANE),
      worktreeId: 'wt-1',
      kind: 'swarm-agent',
      sessionId: displayWorkerId,
      coordinatorSessionId: displayRootId,
      title: '🐽 jcode/castle Piglet',
      runtimeDir: buildJcodeRuntimeDir(PANE),
      command:
        "'/home/user/.local/bin/jcode' '--fresh-spawn' '--provider' 'claude' '--resume' 'session_piglet_1792604760697_211acdce5650ace5'"
    }
    await server.start({ userDataPath: dir, env: 'production' })
    bindJcodeRootSession(server._getStateForTests(), PANE, displayRootId, 'launch')
    runtime = createRuntime()
    registerJcodeSpawnOwner(runtime, () => false)
  })
  afterEach(() => {
    server.stop()
    clearAllListenerCaches(server._getStateForTests())
    for (const listener of paneKeyTeardownListeners) {
      if (!listeners.has(listener)) {
        paneKeyTeardownListeners.delete(listener)
      }
    }
    for (const key of minted) {
      forgetJcodePaneSecret(key)
      const id = paneKeyPtyId.get(key)
      if (id) {
        ptyPaneKey.delete(id)
      }
      paneKeyPtyId.delete(key)
      links.delete(key)
    }
    minted.clear()
    tabs.clear()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })
  async function spawn() {
    const env = server.buildPtyEnv()
    const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/jcode-spawn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Connection: 'close',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: new URLSearchParams(
        Object.entries(request).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    })
    await response.text()
    return response.status
  }
  async function post(payload: Record<string, unknown>) {
    const response = await postHookEvent(server, buildBody(payload), '/hook/jcode')
    expect(response.status).toBe(204)
    await response.text()
  }
  async function replay(payload: Record<string, unknown>) {
    if (!('replay' in server) || typeof server.replay !== 'function') {
      throw new Error('replay ingress missing')
    }
    await server.replay({ ...buildBody(payload), source: 'jcode', receivedAt: Date.now() - 1000 })
  }
  function destination() {
    const opts = runtime.createTerminal.mock.calls.at(-1)![1]
    return `${opts.tabId}:${opts.leafId}`
  }
  function assertReleased() {
    expect(server.findJcodeSessionOwner(displayWorkerId)).toBeUndefined()
    expect(links.entries()).toEqual([])
    expect(
      [...server._getStateForTests().jcodeDisplayBindings.values()].every(
        (b) => b.state === 'closed'
      )
    ).toBe(true)
    const state = server._getStateForTests()
    for (const key of minted) {
      if (!paneKeyPtyId.has(key)) {
        expect(state.jcodeSessions.roots.has(key)).toBe(false)
        expect(
          [...state.jcodeSessions.tombstones.keys()].some((id) => id.startsWith(`${key}\0`))
        ).toBe(false)
      }
    }
  }

  it('agent cleanup preserves workers and authority; real root teardown closes and rejects', async () => {
    expect(await spawn()).toBe(200)
    const child = destination()
    await post(pawprintStart)
    server.reconcileEndedProcessForPaneKeys([PANE], { preserveResumeIdentity: true })
    server.clearPaneState(PANE)
    await post(pawprintStart)
    server.dropStatusEntry(PANE)
    expect(verifyJcodePaneSecret(PANE, request.paneSecret)).toBe(true)
    expect(runtime.closeTerminalTab).not.toHaveBeenCalled()
    expect(server.findJcodeSessionOwner(displayWorkerId)?.paneKey).toBe(child)
    expect(server.jcodeDisplayPanesOfRoot(PANE)).toEqual([child])
    request.kind = 'resume'
    expect(await spawn()).toBe(200)
    expect(runtime.focusTerminal).toHaveBeenCalledOnce()
    expect(runtime.createTerminal).toHaveBeenCalledOnce()
    retire(PANE)
    expect(runtime.closeTerminalTab).toHaveBeenCalledOnce()
    expect(verifyJcodePaneSecret(PANE, request.paneSecret)).toBe(false)
    assertReleased()
    expect(await spawn()).toBe(403)
  })

  it('replaces earlier teardown registration', () => {
    const readChildren = vi.spyOn(server, 'jcodeDisplayPanesOfRoot')
    registerJcodeSpawnOwner(runtime, () => false)
    retire(PANE)
    expect(readChildren).toHaveBeenCalledTimes(1)
  })

  it('leaves a registered creating handle to the completion fence', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    completion = Promise.withResolvers<{ handle: string }>()
    const response = spawn()
    await started.promise
    tabs.set(destination(), 'creating')
    runtime.closeTerminalTab.mockImplementationOnce(async (handle) => {
      const key = [...tabs].find(([, value]) => value === handle)?.[0]
      if (key && paneKeyPtyId.has(key)) {
        retire(key)
      }
    })
    retire(PANE)
    completion.resolve({ handle: 'creating' })
    expect(await response).toBe(503)
    expect(runtime.closeTerminalTab).toHaveBeenCalledExactlyOnceWith('creating')
    expect(warning.mock.calls.flat().join(' ')).not.toContain('Pane cleanup failed')
    assertReleased()
  })

  it('stale PTY teardown cannot retire replacement pane authority', async () => {
    expect(await spawn()).toBe(200)
    const stale = ptyPaneKey.entries().find(([, key]) => key === PANE)?.[0]
    const replacement = attach(PANE)
    clearProviderPtyState(stale!)
    expect(paneKeyPtyId.get(PANE)).toBe(replacement)
    expect(verifyJcodePaneSecret(PANE, request.paneSecret)).toBe(true)
    expect(runtime.closeTerminalTab).not.toHaveBeenCalled()
    expect(server.findJcodeSessionOwner(displayWorkerId)?.state).toBe('open')
  })

  it('plain tab cleanup keeps owner; PTY retirement frees it for one replacement', async () => {
    request.kind = 'resume'
    expect(await spawn()).toBe(200)
    const first = destination()
    server.reconcileEndedProcessForPaneKeys([first], { preserveResumeIdentity: true })
    server.clearPaneState(first)
    server.dropStatusEntry(first)
    expect(server.findJcodeSessionOwner(displayWorkerId)).toEqual({
      paneKey: first,
      role: 'plain',
      state: 'open'
    })
    const secret = mintJcodePaneSecret(first)
    retire(first)
    expect(verifyJcodePaneSecret(first, secret)).toBe(false)
    assertReleased()
    expect(await spawn()).toBe(200)
    expect(destination()).not.toBe(first)
    expect(runtime.createTerminal).toHaveBeenCalledTimes(2)
    expect(runtime.focusTerminal).not.toHaveBeenCalled()
    expect(await spawn()).toBe(200)
    expect(runtime.createTerminal).toHaveBeenCalledTimes(2)
    expect(runtime.focusTerminal).toHaveBeenCalledOnce()
  })

  it.each(['http', 'spool'] as const)(
    'closed display clears session-routing pane state and drops late tool over %s',
    async (ingress) => {
      expect(await spawn()).toBe(200)
      const child = destination()
      await post(pigletStart)
      await post(pigletTurn)
      expect(
        server.getStatusSnapshot().some((row) => row.paneKey === child && row.state === 'working')
      ).toBe(true)
      retire(child)
      const state = server._getStateForTests()
      expect(state.jcodeSessions.roots.has(child)).toBe(false)
      expect(
        [...state.jcodeSessions.tombstones.keys()].some((key) => key.startsWith(`${child}\0`))
      ).toBe(false)
      expect([...state.jcodeDisplayBindings.values()][0]?.state).toBe('closed')
      const listener = vi.fn()
      server.setListener(listener)
      const before = server.getStatusSnapshot()
      await (ingress === 'http' ? post(pigletLateTool) : replay(pigletLateTool))
      expect(listener).not.toHaveBeenCalled()
      expect(server.getStatusSnapshot()).toEqual(before)
      expect(server.rootJcodeSessionId(PANE)).toBe(displayRootId)
    }
  )

  it.each(['plain', 'worker'] as const)(
    'real destination teardown rejects deferred %s creation',
    async (kind) => {
      if (kind === 'plain') {
        request.kind = 'resume'
      }
      completion = Promise.withResolvers<{ handle: string }>()
      const response = spawn()
      await started.promise
      retire(destination())
      completion.resolve({ handle: 'late' })
      expect(await response).toBe(503)
      expect(runtime.closeTerminalTab).toHaveBeenCalledExactlyOnceWith('late')
      assertReleased()
      expect(verifyJcodePaneSecret(PANE, request.paneSecret)).toBe(true)
    }
  )

  it.each(['before completion', 'after completion'] as const)(
    'root retirement fences creation %s',
    async (timing) => {
      completion = Promise.withResolvers<{ handle: string }>()
      const confirm = vi.spyOn(server, 'confirmJcodeSessionTab')
      const response = spawn()
      await started.promise
      if (timing === 'after completion') {
        completion.resolve({ handle: 'late' })
      }
      retireJcodePane({ runtime, server, forgetJcodePaneSecret, isQuitting: () => false }, PANE)
      if (timing === 'before completion') {
        completion.resolve({ handle: 'late' })
      }
      expect(await response).toBe(503)
      expect(confirm).not.toHaveBeenCalled()
      expect(runtime.closeTerminalTab).toHaveBeenCalledExactlyOnceWith('late')
      assertReleased()
      expect(server._getStateForTests().jcodeDisplayBindings.size).toBe(0)
    }
  )

  it('restart loses display bindings and drops captured parent-posted late tool', async () => {
    expect(await spawn()).toBe(200)
    clearAllListenerCaches(server._getStateForTests())
    const before = server.getStatusSnapshot()
    await post(pigletLateTool)
    await replay(pigletLateTool)
    expect(server.getStatusSnapshot()).toEqual(before)
    expect(
      server.getStatusSnapshot().some((row) => row.providerSession?.id === displayWorkerId)
    ).toBe(false)
    expect(server._getStateForTests().jcodeDisplayBindings.size).toBe(0)
    expect(server.rootJcodeSessionId(PANE)).toBeUndefined()
    expect(server.rootJcodeSessionId(destination())).toBeUndefined()
  })
})
