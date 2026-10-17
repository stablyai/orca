import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

const appEvents = vi.hoisted(() => new Map<string, () => void>())
vi.mock('electron', () => ({
  app: {
    on: (name: string, listener: () => void) => appEvents.set(name, listener),
    getPath: () => '/nonexistent-user-data'
  },
  ipcRenderer: {},
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

const trust = vi.hoisted(() => ({ trusted: new Set<number>([1]) }))
vi.mock('./ui', () => ({
  isTrustedUIRenderer: (contents: { id: number }) => trust.trusted.has(contents.id)
}))

import { createDebugApi } from '../../preload/api/debug-api'
import { debugService } from '../debug/debug-service'
import { DEBUG_UNTRUSTED_RENDERER, registerDebugHandlers } from './debug-handlers'

const CHANNELS = [
  'describeAdapters',
  'listConfigs',
  'previewLaunch',
  'approveLaunch',
  'start',
  'stop',
  'restart',
  'continue',
  'next',
  'stepIn',
  'stepOut',
  'pause',
  'threads',
  'stackTrace',
  'scopes',
  'variables',
  'evaluate',
  'setVariable',
  'setExceptionFilters',
  'addBreakpoint',
  'updateBreakpoint',
  'removeBreakpoint',
  'setFileLines',
  'listBreakpoints',
  'snapshot',
  'eventsSince',
  'subscribe'
].map((name) => `debug:${name}`)

function createSender(id: number) {
  return { id, isDestroyed: () => false, send: vi.fn(), once: vi.fn() }
}
const trusted = createSender(1)
const untrusted = createSender(2)

const invoke = (sender: ReturnType<typeof createSender>, channel: string, params?: unknown) => {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }
  return handler({ sender }, params)
}

let root = ''
const at = () => ({ repoId: 'r1', worktreePath: root })
let userData = ''
let settings: Record<string, unknown> = {}

beforeEach(() => {
  handlers.clear()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-debug-handlers-')))
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'orca-debug-handlers-data-')))
  writeFileSync(join(root, 'app.py'), 'a = 1\n')
  settings = {
    debugEnabledRepos: ['r1'],
    debugAdapterApprovals: {},
    debugLaunchApprovals: {},
    debugPythonPath: '',
    debugJsDebugServerPath: ''
  }
  const store = {
    getSettings: () => settings,
    getRepo: (id: string) => (id === 'r1' ? { id: 'r1', path: root } : undefined),
    updateSettings: (updates: Record<string, unknown>) => Object.assign(settings, updates)
  }
  registerDebugHandlers(store as never, {
    userDataPath: userData,
    listRepoRoots: async () => [root],
    // No real interpreter: the preview names a fixed binary on every machine.
    resolveAdapter: async () => ({
      ok: true,
      binaryPath: '/usr/bin/python3',
      args: ['-m', 'debugpy.adapter'],
      spawnArgs: ['-m', 'debugpy.adapter'],
      approvalKey: '["debugpy","/usr/bin/python3","-m","debugpy.adapter"]',
      transport: 'stdio',
      repoLocal: false
    })
  })
})

afterEach(async () => {
  await debugService.dispose()
  rmSync(root, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

describe('debug IPC handlers', () => {
  it('registers every debug channel and refuses each one to an untrusted renderer', async () => {
    expect([...handlers.keys()].sort()).toEqual([...CHANNELS].sort())
    const params = { repoId: 'r1', worktreePath: root, path: join(root, 'app.py'), line: 1 }
    for (const channel of CHANNELS) {
      expect(await invoke(untrusted, channel, params)).toEqual(DEBUG_UNTRUSTED_RENDERER)
    }
    expect(await debugService.listBreakpoints(at())).toEqual([])
  })

  it('shares one breakpoint store between the IPC channels and the service', async () => {
    const file = join(root, 'app.py')
    const added = await invoke(trusted, 'debug:addBreakpoint', { ...at(), path: file, line: 1 })
    expect(added).toMatchObject({ ok: true, value: { path: file, line: 1 } })
    expect(await debugService.listBreakpoints(at())).toHaveLength(1)
    await debugService.addBreakpoint(at(), file, { line: 1, condition: 'a' }, 'ui')
    const listed = await invoke(trusted, 'debug:listBreakpoints', at())
    expect(listed).toMatchObject({ ok: true, value: [{ line: 1 }, { line: 1, condition: 'a' }] })
  })

  it('pushes debug:state to subscribed windows', async () => {
    expect(await invoke(trusted, 'debug:subscribe')).toEqual({ ok: true, value: null })
    await invoke(trusted, 'debug:addBreakpoint', { ...at(), path: join(root, 'app.py'), line: 1 })
    expect(trusted.send).toHaveBeenCalledWith(
      'debug:state',
      expect.objectContaining({ worktreePath: root, status: 'idle' })
    )
    expect(untrusted.send).not.toHaveBeenCalled()
  })

  it('answers bad params and refusals as values, never as thrown errors', async () => {
    expect(await invoke(trusted, 'debug:addBreakpoint', { ...at(), line: 1 })).toMatchObject({
      ok: false,
      reason: 'request-failed'
    })
    const outside = { ...at(), path: join(root, '..', 'x.py'), line: 1 }
    expect(await invoke(trusted, 'debug:addBreakpoint', outside)).toMatchObject({
      ok: false,
      reason: 'outside-worktree'
    })
    expect(await invoke(trusted, 'debug:continue', { ...at(), threadId: 1 })).toMatchObject({
      ok: false,
      reason: 'no-session'
    })
    const start = { repoId: 'r1', worktreePath: root, filePath: join(root, 'app.py') }
    expect(await invoke(trusted, 'debug:start', start)).toMatchObject({ ok: false })
  })

  it('derives the root in main: a breakpoint under a root the repo does not list is refused', async () => {
    const fake = realpathSync(mkdtempSync(join(tmpdir(), 'orca-debug-handlers-fake-')))
    try {
      const forged = { repoId: 'r1', worktreePath: fake, path: join(fake, 'x.py'), line: 1 }
      expect(await invoke(trusted, 'debug:addBreakpoint', forged)).toMatchObject({
        ok: false,
        reason: 'outside-worktree'
      })
      // A bare worktree path without its repo is not enough either.
      const bare = { worktreePath: root, path: join(root, 'app.py'), line: 1 }
      expect(await invoke(trusted, 'debug:addBreakpoint', bare)).toMatchObject({ ok: false })
    } finally {
      rmSync(fake, { recursive: true, force: true })
    }
  })

  it('approves a launch from the trusted window with a human confirmation main mints itself', async () => {
    const start = { ...at(), filePath: join(root, 'app.py') }
    const preview = await invoke(trusted, 'debug:previewLaunch', start)
    const expectedHash = Object(Object(preview).value).expectedHash
    expect(expectedHash).toMatch(/^[0-9a-f]{64}$/)
    const approved = await invoke(trusted, 'debug:approveLaunch', { ...start, expectedHash })
    expect(approved).toMatchObject({ ok: true, value: { approved: { launch: true } } })
    expect(Object.values(Object(settings.debugLaunchApprovals))).toHaveLength(1)
  })

  it('SIGKILLs every adapter synchronously on will-quit, before the async dispose', () => {
    const order: string[] = []
    const kill = vi.spyOn(debugService, 'killAllSync').mockImplementation(() => order.push('kill'))
    const dispose = vi.spyOn(debugService, 'dispose').mockImplementation(async () => {
      order.push('dispose')
    })
    appEvents.get('will-quit')?.()
    expect(order).toEqual(['kill', 'dispose'])
    kill.mockRestore()
    dispose.mockRestore()
  })

  it('delivers a batched debug:output message to the renderer one event at a time', () => {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
    const ipc = {
      invoke: vi.fn(),
      on: (channel: string, listener: (event: unknown, payload: unknown) => void) =>
        listeners.set(channel, listener),
      removeListener: vi.fn()
    }
    const api = createDebugApi(ipc as never)
    const seen: unknown[] = []
    api.onOutput((event) => seen.push(event))
    const event = (seq: number) => ({
      worktreePath: root,
      seq,
      ts: 0,
      category: 'stdout',
      text: 'x'
    })
    listeners.get('debug:output')?.({}, [event(1), event(2)])
    expect(seen).toEqual([event(1), event(2)])
  })
})
