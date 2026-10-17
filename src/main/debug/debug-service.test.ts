import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { debugAdapterApprovalKey, type DebugSettings } from '../../shared/debug-settings-types'
import type { Repo } from '../../shared/repo-types'
import type { DapAdapterRow } from './dap-adapter-registry'
import { DebugService, DebugServiceError, DebugUnavailableError } from './debug-service'
import { getDebugHostRefusal } from './debug-service-trust'
import { buildDebugSnapshot } from './debug-session-breakpoints'

const FAKE = join(__dirname, 'dap-adapter-fake.mjs')
const NODE = process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath
const HUMAN = Symbol('test human')
const CONFIRMED = { [HUMAN]: true } as const
const cleanups: (() => unknown)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const LAUNCH = {
  configurations: [
    { name: 'App', type: 'debugpy', request: 'launch', program: '${workspaceFolder}/app.py' }
  ]
}

function writeLaunch(root: string, content: unknown): void {
  mkdirSync(join(root, '.vscode'), { recursive: true })
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  writeFileSync(join(root, '.vscode', 'launch.json'), text)
}

type SetupOptions = {
  repo?: Partial<Repo>
  enabled?: boolean
  flags?: string[]
  outputRetentionMs?: number
}

function setup(options: SetupOptions = {}) {
  const root = tempDir('orca-debug-service-')
  writeFileSync(join(root, 'app.py'), 'a = 1\nb = 2\nc = 3\n')
  writeLaunch(root, LAUNCH)
  const settings: DebugSettings = {
    debugEnabledRepos: options.enabled === false ? [] : ['r1'],
    debugAdapterApprovals: {},
    debugPythonPath: '',
    debugJsDebugServerPath: '',
    debugLaunchApprovals: {}
  }
  const repo: Repo = {
    id: 'r1',
    path: root,
    displayName: 'r1',
    badgeColor: '',
    addedAt: 0,
    ...options.repo
  }
  // Mutable: a test swaps what "resolves" between preview and approve.
  const adapter = { binary: NODE, args: [FAKE, ...(options.flags ?? ['--stop-on-entry'])] }
  const service = new DebugService()
  service.configure({
    getSettings: () => settings,
    getRepo: (id) => (id === 'r1' ? repo : undefined),
    listRepoRoots: async () => [root],
    updateSettings: (updates) => Object.assign(settings, updates),
    userDataPath: tempDir('orca-debug-userdata-'),
    humanKey: HUMAN,
    outputRetentionMs: options.outputRetentionMs,
    resolveAdapter: async (row: DapAdapterRow) => ({
      ok: true,
      binaryPath: adapter.binary,
      args: adapter.args,
      spawnArgs: adapter.args,
      approvalKey: debugAdapterApprovalKey(row.id, adapter.binary, adapter.args),
      transport: 'stdio',
      repoLocal: false
    })
  })
  cleanups.push(() => service.dispose())
  const at = { repoId: 'r1', worktreePath: root }
  const target = { ...at, configName: 'App' }
  const approvalKey = () => debugAdapterApprovalKey('debugpy', adapter.binary, adapter.args)
  return { root, repo, settings, service, at, target, approvalKey, adapter }
}
type Ctx = ReturnType<typeof setup>

async function approve(ctx: Ctx): Promise<string> {
  const preview = await ctx.service.previewLaunch(ctx.target)
  if (!preview.ok) {
    throw new Error(preview.message)
  }
  const approved = await ctx.service.approveLaunch(
    { ...ctx.target, expectedHash: preview.value.expectedHash },
    CONFIRMED
  )
  expect(approved.ok).toBe(true)
  return preview.value.expectedHash
}

/** The entry stop can land after start resolves; wait for it only when it has not. */
async function startedAndStopped(ctx: Ctx, origin: 'ui' | 'cli' = 'ui') {
  const result = await ctx.service.start({ ...ctx.target, origin })
  expect(result.ok).toBe(true)
  if ((await ctx.service.snapshot(ctx.at)).status !== 'stopped') {
    await ctx.service.waitFor(ctx.at, ['stopped'], 5000)
  }
  expect((await ctx.service.snapshot(ctx.at)).status).toBe('stopped')
}

const reasonOf = (result: { ok: boolean; reason?: string }) => (result.ok ? 'ok' : result.reason)
const thrownReason = (work: Promise<unknown>) =>
  work.then(
    () => 'ok',
    (error: unknown) => (error instanceof DebugServiceError ? error.reason : String(error))
  )

describe('debugService trust gate', () => {
  it('refuses in order, each step fixing exactly the gate before it: root, host, repo, launch.json, adapter, launch', async () => {
    // Every gate starts broken; each step fixes only the one that just answered.
    const ctx = setup({ enabled: false, repo: { executionHostId: 'ssh:box' } })
    writeLaunch(ctx.root, '{ "configurations": [')
    const start = (extra: Partial<Parameters<typeof ctx.service.start>[0]> = {}) =>
      ctx.service.start({ ...ctx.target, origin: 'cli', ...extra })
    expect(reasonOf(await start({ worktreePath: tempDir('orca-debug-elsewhere-') }))).toBe(
      'outside-worktree'
    )
    expect(reasonOf(await start())).toBe('remote-workspace')
    ctx.repo.executionHostId = undefined
    expect(reasonOf(await start())).toBe('repo-not-enabled')
    ctx.settings.debugEnabledRepos = ['r1']
    expect(reasonOf(await start())).toBe('malformed')
    writeLaunch(ctx.root, LAUNCH)
    expect(reasonOf(await start())).toBe('adapter-not-approved')
    ctx.settings.debugAdapterApprovals = { r1: [ctx.approvalKey()] }
    expect(reasonOf(await start())).toBe('launch-not-approved')
  })

  it('allows only a local host: ssh, runtime and any unknown host kind are refused', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: includes a host kind the type does not know yet, which is the point.
    const hosts = ['ssh:box', 'runtime:env-1', 'future-kind:x'] as Repo['executionHostId'][]
    for (const executionHostId of hosts) {
      const ctx = setup({ repo: { executionHostId } })
      expect(reasonOf(await ctx.service.start({ ...ctx.target, origin: 'ui' }))).toBe(
        'remote-workspace'
      )
    }
    const repo = (extra: Partial<Repo>): Repo => ({
      id: 'w',
      path: '/x',
      displayName: 'w',
      badgeColor: '',
      addedAt: 0,
      ...extra
    })
    expect(getDebugHostRefusal(repo({ connectionId: 'c1' }), '/x')).toMatch(/SSH/)
    expect(getDebugHostRefusal(repo({ executionHostId: 'local' }), '/x')).toBeNull()
    expect(getDebugHostRefusal(repo({}), '/x')).toBeNull()
  })

  it('refuses WSL roots on Windows like the language-server gate', () => {
    const repo: Repo = { id: 'w', path: 'x', displayName: 'w', badgeColor: '', addedAt: 0 }
    expect(getDebugHostRefusal(repo, '\\\\wsl.localhost\\Ubuntu\\src', 'win32')).toMatch(/WSL/)
    expect(getDebugHostRefusal(repo, '/home/src', 'linux')).toBeNull()
  })

  it('records the adapter key and config hash only on a matching, human-confirmed approveLaunch', async () => {
    const ctx = setup()
    expect(reasonOf(await ctx.service.start({ ...ctx.target, origin: 'ui' }))).toBe(
      'adapter-not-approved'
    )
    const stale = await ctx.service.approveLaunch({ ...ctx.target, expectedHash: 'x' }, CONFIRMED)
    expect(reasonOf(stale)).toBe('changed-since-preview')
    const preview = await ctx.service.previewLaunch(ctx.target)
    const expectedHash = preview.ok ? preview.value.expectedHash : ''
    // An RPC or CLI path has no HUMAN symbol, so it cannot build a confirmation.
    for (const forged of [undefined, { [Symbol('test human')]: true } as const]) {
      const refused = await ctx.service.approveLaunch({ ...ctx.target, expectedHash }, forged)
      expect(reasonOf(refused)).toBe('human-confirmation-required')
    }
    expect(ctx.settings.debugLaunchApprovals).toEqual({})
    expect(ctx.settings.debugAdapterApprovals).toEqual({})
    const hash = await approve(ctx)
    expect(ctx.settings.debugLaunchApprovals).toEqual({
      r1: [preview.ok ? preview.value.configHash : '']
    })
    expect(ctx.settings.debugAdapterApprovals).toEqual({ r1: [ctx.approvalKey()] })
    const started = await ctx.service.start({ ...ctx.target, origin: 'ui', expectedHash: hash })
    expect(started.ok && started.value.configName).toBe('App')
  })

  it('binds the adapter into the preview hash: a binary swapped after preview is refused', async () => {
    const ctx = setup()
    const preview = await ctx.service.previewLaunch(ctx.target)
    expect(preview.ok && preview.value.adapter.repoLocal).toBe(false)
    const expectedHash = preview.ok ? preview.value.expectedHash : ''
    // An agent drops .venv/bin/python while the confirmation is on screen.
    ctx.adapter.binary = join(ctx.root, '.venv', 'bin', 'python')
    const approved = await ctx.service.approveLaunch({ ...ctx.target, expectedHash }, CONFIRMED)
    expect(reasonOf(approved)).toBe('changed-since-preview')
    expect(ctx.settings.debugAdapterApprovals).toEqual({})
    ctx.adapter.binary = NODE
    const hash = await approve(ctx)
    ctx.adapter.args = [...ctx.adapter.args, '--evil']
    const started = await ctx.service.start({ ...ctx.target, origin: 'ui', expectedHash: hash })
    expect(reasonOf(started)).toBe('changed-since-preview')
  })

  it('lets the cli start only a configuration a person approved', async () => {
    const ctx = setup()
    await approve(ctx)
    expect(reasonOf(await ctx.service.start({ ...ctx.target, origin: 'cli' }))).toBe('ok')
  })

  it('refuses a start after launch.json changed since the preview', async () => {
    const ctx = setup()
    const hash = await approve(ctx)
    writeLaunch(ctx.root, { configurations: [{ ...LAUNCH.configurations[0], args: ['--evil'] }] })
    const stale = await ctx.service.start({ ...ctx.target, origin: 'ui', expectedHash: hash })
    expect(reasonOf(stale)).toBe('changed-since-preview')
    expect(reasonOf(await ctx.service.start({ ...ctx.target, origin: 'cli' }))).toBe(
      'launch-not-approved'
    )
  })

  it('throws debug_unavailable from every operational method of an unconfigured service', async () => {
    const service = new DebugService()
    const at = { repoId: 'r1', worktreePath: '/w' }
    const calls: Record<string, () => unknown> = {
      onState: () => service.onState(() => {}),
      onOutput: () => service.onOutput(() => {}),
      describeAdapters: () => service.describeAdapters(),
      listConfigs: () => service.listConfigs('r1', '/w'),
      previewLaunch: () => service.previewLaunch(at),
      approveLaunch: () => service.approveLaunch({ ...at, expectedHash: 'h' }, CONFIRMED),
      start: () => service.start({ ...at, origin: 'ui' }),
      stop: () => service.stop(at),
      restart: () => service.restart(at, 'ui'),
      inspect: () => service.inspect(at),
      control: () => service.control(at, 'ui'),
      cliControlSeq: () => service.cliControlSeq(at),
      setExceptionFilters: () => service.setExceptionFilters(at, []),
      addBreakpoint: () => service.addBreakpoint(at, '/w/a.py', { line: 1 }, 'ui'),
      updateBreakpoint: () => service.updateBreakpoint(at, 'id', {}, 'ui'),
      removeBreakpoint: () => service.removeBreakpoint(at, 'id'),
      setFileLines: () => service.setFileLines(at, '/w/a.py', []),
      listBreakpoints: () => service.listBreakpoints(at),
      snapshot: () => service.snapshot(at),
      eventsSince: () => service.eventsSince(at, 0),
      waitFor: () => service.waitFor(at, ['stopped'], 10)
    }
    // Lifecycle methods and private helpers; any other method must appear in `calls`.
    const lifecycle = ['constructor', 'configure', 'dispose', 'killAllSync']
    // markCliControl only stamps a session control() already returned, so it needs no config.
    const helpers = [
      'ready',
      'trusted',
      'entry',
      'settle',
      'setTimer',
      'onSessionState',
      'markCliControl'
    ]
    const more = ['scheduleRelease', 'sync', 'push', 'bump', 'breakpointsOf', 'buildSnapshot']
    const internal = new Set([...lifecycle, ...helpers, ...more])
    const methods = Object.getOwnPropertyNames(DebugService.prototype)
    expect(methods.filter((name) => !internal.has(name)).sort()).toEqual(Object.keys(calls).sort())
    for (const [name, call] of Object.entries(calls)) {
      const error = await Promise.resolve()
        .then(call)
        .then(
          () => null,
          (caught: unknown) => caught
        )
      expect(error, name).toBeInstanceOf(DebugUnavailableError)
    }
  })
})

describe('debugService origins', () => {
  it('lets a cli caller read a person’s session but never step, evaluate, restart or set code fields', async () => {
    const ctx = setup()
    await approve(ctx)
    await startedAndStopped(ctx, 'ui')
    const reader = await ctx.service.inspect(ctx.at)
    expect(await reader.threads()).toEqual([{ id: 1, name: 'main' }])
    expect(await thrownReason(ctx.service.control(ctx.at, 'cli'))).toBe('human-session')
    expect(await thrownReason(ctx.service.restart(ctx.at, 'cli'))).toBe('human-session')
    const file = join(ctx.root, 'app.py')
    for (const field of ['condition', 'hitCondition', 'logMessage']) {
      const fields = { line: 2, [field]: 'x' }
      expect(await thrownReason(ctx.service.addBreakpoint(ctx.at, file, fields, 'cli'))).toBe(
        'human-session'
      )
    }
    const plain = await ctx.service.addBreakpoint(ctx.at, file, { line: 2 }, 'cli')
    expect(
      await thrownReason(ctx.service.updateBreakpoint(ctx.at, plain.id, { condition: 'x' }, 'cli'))
    ).toBe('human-session')
    // The person keeps every control of their own session.
    expect(await (await ctx.service.control(ctx.at, 'ui')).evaluate('1+1')).toMatchObject({})
  })

  it('records the origin, so a cli caller drives the session it started', async () => {
    const ctx = setup()
    await approve(ctx)
    await startedAndStopped(ctx, 'cli')
    const session = await ctx.service.control(ctx.at, 'cli')
    expect((await session.evaluate('a', 0)).result).toBe('a@0')
    const file = join(ctx.root, 'app.py')
    const conditional = await ctx.service.addBreakpoint(
      ctx.at,
      file,
      { line: 2, condition: 'a' },
      'cli'
    )
    expect(conditional.condition).toBe('a')
  })

  it('spawns the adapter outside the worktree, so `python -m` cannot load repo modules', async () => {
    const ctx = setup()
    await approve(ctx)
    await startedAndStopped(ctx)
    const session = await ctx.service.control(ctx.at, 'ui')
    const { cwd } = Object((await session.customRequest('fake/env')).body)
    expect(realpathSync(cwd)).toBe(realpathSync(homedir()))
  })

  it('killAllSync SIGKILLs every adapter at once, without awaiting a polite stop', async () => {
    const ctx = setup({ flags: ['--stop-on-entry', '--ignore-sigterm'] })
    await approve(ctx)
    await startedAndStopped(ctx)
    const session = await ctx.service.control(ctx.at, 'ui')
    const { pid } = Object((await session.customRequest('fake/pids')).body)
    ctx.service.killAllSync()
    const alive = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    await expect.poll(alive, { timeout: 1000 }).toBe(false)
  })
})

describe('debugService sessions and state feed', () => {
  it('runs one session per worktree', async () => {
    const ctx = setup()
    await approve(ctx)
    expect(reasonOf(await ctx.service.start({ ...ctx.target, origin: 'ui' }))).toBe('ok')
    expect(reasonOf(await ctx.service.start({ ...ctx.target, origin: 'ui' }))).toBe(
      'already-debugging'
    )
  })

  it('waitFor resolves on the next stopped state and times out otherwise', async () => {
    const ctx = setup()
    await approve(ctx)
    await ctx.service.addBreakpoint(ctx.at, join(ctx.root, 'app.py'), { line: 3 }, 'ui')
    await startedAndStopped(ctx)
    expect((await ctx.service.waitFor(ctx.at, ['terminated'], 50)).timedOut).toBe(true)
    const next = ctx.service.waitFor(ctx.at, ['stopped', 'terminated'], 5000)
    await (await ctx.service.control(ctx.at, 'ui')).continue(1)
    const { timedOut, snapshot } = await next
    expect(timedOut).toBe(false)
    expect(snapshot.stopped).toMatchObject({ reason: 'breakpoint', threadId: 1 })
    const done = ctx.service.waitFor(ctx.at, ['stopped', 'terminated'], 5000)
    await (await ctx.service.control(ctx.at, 'ui')).continue(1)
    expect((await done).snapshot.status).toBe('terminated')
    const { events } = await ctx.service.eventsSince(ctx.at, 0)
    const output = events.flatMap((event) => ('kind' in event ? [] : [event.text]))
    expect(output).toContain('fake program finished\n')
  })

  it('serializes the stopped snapshot and the state event exactly as the wire contract names them', async () => {
    const ctx = setup()
    await approve(ctx)
    await startedAndStopped(ctx)
    const snapshot = JSON.parse(JSON.stringify(await ctx.service.snapshot(ctx.at)))
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        'adapterId',
        'breakpoints',
        'capabilities',
        'configName',
        'exceptionFilters',
        'lastError',
        'seq',
        'status',
        'stopped',
        'threads',
        'worktreePath'
      ].sort()
    )
    expect(snapshot.stopped).toEqual({ reason: 'entry', threadId: 1, allThreadsStopped: true })
    const { events } = await ctx.service.eventsSince(ctx.at, 0)
    const states = events.filter((event) => 'kind' in event)
    expect(states.length).toBeGreaterThan(0)
    for (const state of states) {
      expect(Object.keys(JSON.parse(JSON.stringify(state))).sort()).toEqual([
        'kind',
        'seq',
        'status'
      ])
    }
  })

  it('reports stopped as null when the adapter named no thread', () => {
    const entry = {
      seq: 1,
      root: '/w',
      launch: null,
      threads: [],
      exceptionFilters: undefined,
      lastError: null
    }
    const state = { status: 'stopped' as const, stoppedReason: 'pause', allThreadsStopped: true }
    const session = { state, capabilities: {} }
    expect(buildDebugSnapshot({ ...entry, session }, []).stopped).toBeNull()
    const withThread = { ...session, state: { ...state, threadId: 4, description: 'Paused' } }
    expect(buildDebugSnapshot({ ...entry, session: withThread }, []).stopped).toEqual({
      reason: 'pause',
      threadId: 4,
      allThreadsStopped: true,
      description: 'Paused'
    })
  })

  it('pushes output in batches of at most one per 50 ms', async () => {
    const ctx = setup()
    await approve(ctx)
    const batches: number[] = []
    ctx.service.onOutput((events) => batches.push(events.length))
    await startedAndStopped(ctx)
    const session = await ctx.service.control(ctx.at, 'ui')
    await session.customRequest('fake/burst', { count: 500 })
    await ctx.service.snapshot(ctx.at)
    await expect.poll(() => batches.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(500)
    expect(batches.length).toBeLessThanOrEqual(4)
  })

  it('frees a finished session’s output after the retention window', async () => {
    const ctx = setup({ outputRetentionMs: 50 })
    await approve(ctx)
    await startedAndStopped(ctx)
    const done = ctx.service.waitFor(ctx.at, ['terminated'], 5000)
    await (await ctx.service.control(ctx.at, 'ui')).continue(1)
    await done
    const text = async () =>
      (await ctx.service.eventsSince(ctx.at, 0)).events.filter((event) => 'text' in event).length
    expect(await text()).toBeGreaterThan(0)
    await expect.poll(text, { timeout: 2000 }).toBe(0)
    expect((await ctx.service.eventsSince(ctx.at, 0)).truncated).toBe(true)
  })

  it('bumps a strictly increasing seq on every change', async () => {
    const ctx = setup()
    const first = (await ctx.service.snapshot(ctx.at)).seq
    await ctx.service.addBreakpoint(ctx.at, join(ctx.root, 'app.py'), { line: 1 }, 'ui')
    await ctx.service.setExceptionFilters(ctx.at, ['raised'])
    const later = await ctx.service.snapshot(ctx.at)
    expect(later.seq).toBeGreaterThan(first)
    expect(later.exceptionFilters.enabled).toEqual(['raised'])
    const seqs = (await ctx.service.eventsSince(ctx.at, 0)).events.map((event) => event.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('reports truncated once the 2000-event ring evicted what was asked for', async () => {
    const ctx = setup()
    for (let i = 0; i < 2100; i++) {
      await ctx.service.setExceptionFilters(ctx.at, [`f${i}`])
    }
    const all = await ctx.service.eventsSince(ctx.at, 0)
    expect(all.truncated).toBe(true)
    expect(all.events).toHaveLength(2000)
    const recent = await ctx.service.eventsSince(ctx.at, all.latestSeq - 5)
    expect(recent).toMatchObject({ truncated: false, latestSeq: all.latestSeq })
    expect(recent.events).toHaveLength(5)
  })
})

describe('debugService breakpoints', () => {
  it('refuses a breakpoint outside the worktree', async () => {
    const ctx = setup()
    const elsewhere = tempDir('orca-debug-other-')
    for (const path of [join(elsewhere, 'x.py'), join(ctx.root, '..', 'x.py')]) {
      expect(await thrownReason(ctx.service.addBreakpoint(ctx.at, path, { line: 1 }, 'ui'))).toBe(
        'outside-worktree'
      )
    }
    expect(await ctx.service.listBreakpoints(ctx.at)).toEqual([])
  })

  it('derives the root in main: a root not in listRepoRoots is refused, even with a file inside it', async () => {
    const ctx = setup()
    const fake = tempDir('orca-debug-fake-root-')
    const forged = { repoId: 'r1', worktreePath: fake }
    const file = join(fake, 'x.py')
    for (const work of [
      ctx.service.addBreakpoint(forged, file, { line: 1 }, 'ui'),
      ctx.service.listBreakpoints(forged),
      ctx.service.setFileLines(forged, file, []),
      ctx.service.snapshot(forged),
      ctx.service.eventsSince(forged, 0),
      ctx.service.setExceptionFilters(forged, [])
    ]) {
      expect(await thrownReason(work)).toBe('outside-worktree')
    }
    expect(await thrownReason(ctx.service.listBreakpoints({ ...forged, repoId: 'nope' }))).toBe(
      'unknown-repo'
    )
  })

  it('setFileLines moves by id, keeping the condition and enabled state', async () => {
    const ctx = setup()
    const file = join(ctx.root, 'app.py')
    const kept = await ctx.service.addBreakpoint(
      ctx.at,
      file,
      { line: 2, condition: 'a > 1', enabled: false },
      'ui'
    )
    const dropped = await ctx.service.addBreakpoint(ctx.at, file, { line: 3 }, 'ui')
    const moved = await ctx.service.setFileLines(ctx.at, file, [{ id: kept.id, line: 5 }])
    expect(moved).toEqual([
      expect.objectContaining({ id: kept.id, line: 5, condition: 'a > 1', enabled: false })
    ])
    expect(await thrownReason(ctx.service.removeBreakpoint(ctx.at, dropped.id))).toBe(
      'unknown-breakpoint'
    )
  })
})

/** Every breakpoint the adapter of the worktree's current session was sent. */
async function sentBreakpoints(ctx: Ctx): Promise<Record<string, unknown>[]> {
  const session = await ctx.service.control(ctx.at, 'ui')
  const { messages } = Object((await session.customRequest('fake/received')).body)
  return [messages]
    .flat()
    .map((entry) => Object(Object(entry).message))
    .filter((message) => message.command === 'setBreakpoints')
    .flatMap((message) => message.arguments.breakpoints)
}

describe('debugService agent-authored breakpoints', () => {
  it('never sends an agent’s condition to a person’s session; sends it to an agent’s', async () => {
    const ctx = setup()
    await approve(ctx)
    const file = join(ctx.root, 'app.py')
    await startedAndStopped(ctx, 'cli')
    await ctx.service.addBreakpoint(ctx.at, file, { line: 2, condition: 'a' }, 'cli')
    await expect.poll(() => sentBreakpoints(ctx)).toContainEqual({ line: 2, condition: 'a' })
    await ctx.service.stop(ctx.at, 'cli')

    await startedAndStopped(ctx, 'ui')
    expect(await sentBreakpoints(ctx)).toEqual([{ line: 2 }])
    const [listed] = await ctx.service.listBreakpoints(ctx.at)
    expect(listed).toMatchObject({ author: 'cli', condition: 'a' })
    expect(listed.answer.message).toBe('agent-written condition withheld')
    await ctx.service.stop(ctx.at, 'ui')

    await startedAndStopped(ctx, 'cli')
    expect(await sentBreakpoints(ctx)).toEqual([{ line: 2, condition: 'a' }])
    const [again] = await ctx.service.listBreakpoints(ctx.at)
    expect(again.answer.message).not.toBe('agent-written condition withheld')
  })

  it('a person editing an agent’s condition adopts it', async () => {
    const ctx = setup()
    await approve(ctx)
    await startedAndStopped(ctx, 'cli')
    const file = join(ctx.root, 'app.py')
    const bp = await ctx.service.addBreakpoint(ctx.at, file, { line: 2, logMessage: '{a}' }, 'cli')
    await ctx.service.stop(ctx.at, 'cli')
    const toggled = await ctx.service.updateBreakpoint(ctx.at, bp.id, { enabled: false }, 'ui')
    expect(toggled).toMatchObject({ author: 'cli' })
    const adopted = await ctx.service.updateBreakpoint(ctx.at, bp.id, { condition: 'a' }, 'ui')
    expect(adopted).toMatchObject({ author: 'ui', condition: 'a' })
  })

  it('refuses a cli caller that stops a person’s session or changes a person’s breakpoint', async () => {
    const ctx = setup()
    await approve(ctx)
    const file = join(ctx.root, 'app.py')
    const human = await ctx.service.addBreakpoint(ctx.at, file, { line: 2 }, 'ui')
    const agent = await ctx.service.addBreakpoint(ctx.at, file, { line: 3 }, 'cli')
    await startedAndStopped(ctx, 'ui')
    expect(await thrownReason(ctx.service.stop(ctx.at, 'cli'))).toBe('human-session')
    expect(await thrownReason(ctx.service.removeBreakpoint(ctx.at, human.id, 'cli'))).toBe(
      'human-session'
    )
    const disable = ctx.service.updateBreakpoint(ctx.at, human.id, { enabled: false }, 'cli')
    expect(await thrownReason(disable)).toBe('human-session')
    await ctx.service.removeBreakpoint(ctx.at, agent.id, 'cli')
    expect((await ctx.service.listBreakpoints(ctx.at)).map((bp) => bp.id)).toEqual([human.id])
    expect(reasonOf(await ctx.service.stop(ctx.at, 'ui'))).toBe('ok')
  })
})

describe('debugService wait since a cli control', () => {
  it('resolves at once on a stop that happened after the cli start, before wait was called', async () => {
    const ctx = setup()
    await approve(ctx)
    expect(reasonOf(await ctx.service.start({ ...ctx.target, origin: 'cli' }))).toBe('ok')
    await expect.poll(async () => (await ctx.service.snapshot(ctx.at)).status).toBe('stopped')
    const since = await ctx.service.cliControlSeq(ctx.at)
    expect(since).not.toBeNull()
    const caught = await ctx.service.waitFor(ctx.at, ['stopped'], 50, since ?? undefined)
    expect(caught.timedOut).toBe(false)
    // Without a seq, wait still means the NEXT state.
    expect((await ctx.service.waitFor(ctx.at, ['stopped'], 50)).timedOut).toBe(true)
  })

  it('markCliControl stamps the seq a continue starts from', async () => {
    const ctx = setup()
    await approve(ctx)
    await ctx.service.addBreakpoint(ctx.at, join(ctx.root, 'app.py'), { line: 3 }, 'cli')
    await startedAndStopped(ctx, 'cli')
    const session = await ctx.service.control(ctx.at, 'cli')
    const seq = ctx.service.markCliControl(session)
    expect(await ctx.service.cliControlSeq(ctx.at)).toBe(seq)
    // The entry stop is before seq, so it does not count.
    expect((await ctx.service.waitFor(ctx.at, ['stopped'], 50, seq)).timedOut).toBe(true)
    await session.continue(1)
    await expect
      .poll(async () => (await ctx.service.snapshot(ctx.at)).stopped?.reason)
      .toBe('breakpoint')
    const { timedOut, snapshot } = await ctx.service.waitFor(ctx.at, ['stopped'], 50, seq)
    expect(timedOut).toBe(false)
    expect(snapshot.stopped).toMatchObject({ reason: 'breakpoint' })
    expect((await ctx.service.waitFor(ctx.at, ['terminated'], 50, seq)).timedOut).toBe(true)
  })
})
