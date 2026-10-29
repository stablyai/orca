import { access, mkdir, readdir, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import capture from '../../shared/__fixtures__/omp-native-commands.json'
import { buildNativeChatPickerItems } from '../../shared/native-chat/input/native-chat-picker-items'
import { sessionReportedSkills } from '../../shared/native-chat/input/native-chat-slash-commands'
import { AT_REST_COMMANDS_TTL_MS } from '../native-chat/agent-session-wire/at-rest-command-catalog'
import { PrioritySemaphore } from '../../shared/priority-semaphore'
import { refreshAtRestCommandContext } from '../native-chat/agent-session-wire/at-rest-command-context'
import {
  commandDiscoveryRig,
  DISCOVERY_SESSION,
  ompRecord
} from './acp-command-discovery.test-fixture'
import { deferred, tick } from './acp-scripted-agent.test-support'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    stat: vi.fn(async (path: Parameters<typeof fs.stat>[0]) => statSync(path)),
    rm: vi.fn(actual.rm)
  }
})

const { rm } = await vi.importActual<typeof fs>('node:fs/promises')

const rigs: Awaited<ReturnType<typeof commandDiscoveryRig>>[] = []
// Let real filesystem/protocol I/O finish without advancing the attempt's fake clock.
const waitFor = (assertion: () => void) => vi.waitFor(assertion, { interval: 0, timeout: 2_000 })
async function rig(...args: Parameters<typeof commandDiscoveryRig>) {
  const opened = await commandDiscoveryRig(...args)
  rigs.push(opened)
  return opened
}
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()))
  vi.restoreAllMocks()
})

it('observes pre-initialize reports, validates session identity and keeps the latest explicit empty', async () => {
  const { catalog, children, workspacePath } = await rig((child) => {
    child.agent.on('initialize', (frame) => {
      child.agent.notify('session/update', { sessionId: 'wrong', update: capture.enabled })
      child.agent.notify('session/update', {
        sessionId: DISCOVERY_SESSION,
        update: capture.enabled
      })
      child.agent.notify('session/update', {
        sessionId: DISCOVERY_SESSION,
        update: { sessionUpdate: 'available_commands_update', availableCommands: [] }
      })
      child.agent.reply(frame, { protocolVersion: 1, agentCapabilities: {} })
    })
    child.agent.on('session/new', (frame) =>
      child.agent.reply(frame, { sessionId: DISCOVERY_SESSION })
    )
  })
  expect(await catalog.settled(ompRecord(), 1_000)).toEqual([])
  await catalog.closeAll()
  expect(children[0]!.launch).toMatchObject({
    command: '/configured/omp',
    cwd: workspacePath('workspace-1'),
    args: ['acp', '--plugin-dir', '/installed/plugin', '--session-dir', expect.any(String)],
    env: { PI_CODING_AGENT_DIR: '/accounts/omp', OMP_PROFILE: 'configured' },
    envToDelete: expect.arrayContaining([
      'ORCA_CHAT_SCRATCH_DIR',
      'ORCA_CHAT_VISUALS_DIR',
      'ORCA_PANE_KEY'
    ])
  })
  expect(children[0]!.agent.frames.map((frame) => frame.method)).toEqual([
    'initialize',
    'session/new'
  ])
  expect(children[0]!.agent.frames[1]!.params).toEqual({
    cwd: workspacePath('workspace-1'),
    mcpServers: []
  })
  expect(children[0]!.lastCloseResult).toEqual({ root: 'exited', tree: null })
})

it.each([
  ['missing', capture.enabled],
  ['wrong', capture.disabled]
] as const)(
  'retains a real answer through three %s reports and recovers on the fourth due attempt',
  async (failure, initial) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const recovered = initial === capture.enabled ? capture.disabled : capture.enabled
    const { catalog, children } = await rig((child) => {
      child.agent.on('session/new', (frame) => {
        const update = children.length === 1 ? initial : children.length === 5 ? recovered : null
        if (update) {
          child.agent.notify('session/update', { sessionId: DISCOVERY_SESSION, update })
        } else if (failure === 'wrong') {
          child.agent.notify('session/update', { sessionId: 'wrong', update: capture.enabled })
        }
        child.agent.reply(frame, { sessionId: DISCOVERY_SESSION })
      })
    })
    const changed = vi.fn()
    catalog.onChange(changed)
    const record = ompRecord()
    const first = await catalog.settled(record, 1_000)
    expect(first?.map((row) => row.name)).toEqual(initial.availableCommands.map((row) => row.name))
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    await vi.advanceTimersByTimeAsync(AT_REST_COMMANDS_TTL_MS)
    for (let attempt = 2; attempt <= 4; attempt++) {
      const failed = catalog.settled(record, 10_000)
      await waitFor(() =>
        expect(children[attempt - 1]?.agent.frames.at(-1)?.method).toBe('session/new')
      )
      await vi.advanceTimersByTimeAsync(9_000)
      expect(await failed).toEqual(first)
      await waitFor(() => expect(children[attempt - 1]?.exited).toBe(true))
      expect(changed).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(9_999)
      catalog.read(record)
      expect(children).toHaveLength(attempt)
      await vi.advanceTimersByTimeAsync(1)
    }
    const fourth = await catalog.settled(record, 10_000)
    expect(fourth?.map((row) => row.name)).toEqual(
      recovered.availableCommands.map((row) => row.name)
    )
    expect(children).toHaveLength(5)
    expect(changed).toHaveBeenCalledTimes(2)
    await catalog.closeAll()
  }
)

it.each(['retire', 'deadline'] as const)(
  'prevents session/new after delayed initialize and %s',
  async (cancel) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const initialization = deferred<void>()
    const { catalog, children } = await rig((child) => {
      const initialize = child.initialize.bind(child)
      vi.spyOn(child, 'initialize').mockImplementation(async () => {
        await initialization.promise
        return initialize()
      })
    })
    if (cancel === 'deadline') {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    }
    catalog.read(ompRecord())
    await waitFor(() => expect(children).toHaveLength(1))
    if (cancel === 'retire') {
      catalog.retireContext()
    } else {
      await vi.advanceTimersByTimeAsync(9_000)
    }
    await catalog.closeAll()
    initialization.resolve()
    await tick()
    expect(children[0]!.agent.frames.some((frame) => frame.method === 'session/new')).toBe(false)
    expect(children[0]!.closes).toBe(1)
  }
)

it('starts the 9 second deadline before readiness and cwd resolution', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const readiness = deferred<void>()
  const refreshing = refreshAtRestCommandContext(() => readiness.promise)
  const cwd = deferred<string>()
  const resolveWorkspacePath = vi.fn(() => cwd.promise)
  const { catalog, children } = await rig(undefined, { resolveWorkspacePath })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const first = catalog.settled(ompRecord('waiting-ready'), 10_000)
  await vi.advanceTimersByTimeAsync(9_000)
  expect(await first).toBeUndefined()
  readiness.resolve()
  await refreshing
  expect(resolveWorkspacePath).not.toHaveBeenCalled()
  const second = catalog.settled(ompRecord('waiting-cwd'), 10_000)
  await vi.advanceTimersByTimeAsync(9_000)
  expect(await second).toBeUndefined()
  cwd.resolve('/work/late')
  await tick()
  expect(children).toEqual([])
})

it('settles availability at the deadline but retains admission and shutdown ownership through a late version reader', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const version = deferred<{ version: string }>()
  const probeVersion = vi.fn(() => version.promise)
  const { catalog, children } = await rig(undefined, { probeVersion })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const reads = ['one', 'two', 'three'].map((id) => catalog.settled(ompRecord(id), 10_000))
  await waitFor(() => expect(probeVersion).toHaveBeenCalledTimes(2))
  await vi.advanceTimersByTimeAsync(9_000)
  expect(await Promise.all(reads)).toEqual([undefined, undefined, undefined])
  expect(probeVersion).toHaveBeenCalledTimes(2)
  let drained = false
  const stop = catalog.closeAll().then(() => {
    drained = true
  })
  await tick()
  expect(drained).toBe(false)
  version.resolve({ version: '18.12.6' })
  await stop
  expect(children).toEqual([])
})

it.each([10, 100, 257])(
  'bounds the actual read trigger at %i contexts without evicting answers or spawning on queries',
  async (count) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const close = deferred<void>()
    const { catalog, children, root } = await rig((child) => {
      const prove = child.proveClose
      child.proveClose = async () => {
        await close.promise
        return prove()
      }
    })
    const records = Array.from({ length: count }, (_, index) => ompRecord(`context-${index}`))
    let subscribers = records
    let publications = 0
    catalog.onChange(() => {
      publications++
      subscribers.forEach((record) => catalog.read(record))
    })
    records.forEach((record) => {
      catalog.read(record)
      catalog.read(record)
    })
    await waitFor(() => expect(children.filter((child) => child.closes === 1)).toHaveLength(2))
    expect(publications).toBe(2)
    expect(await readdir(join(root, 'acp-command-sessions', 'omp'))).toHaveLength(2)
    const rows = catalog.read(records[0]!)!
    for (let index = 0; index < count; index++) {
      buildNativeChatPickerItems([], [], `plan${index}`, '/', sessionReportedSkills(rows, 'omp'))
    }
    expect(children).toHaveLength(2)
    subscribers = records.filter((_, index) => index < 2 || index >= 5)
    records.slice(2, 5).forEach((record) => catalog.retireContext(record.location.workspaceId))
    await tick()
    expect(catalog.read(records[0]!)).toEqual(rows)
    close.resolve()
    await waitFor(() => expect(children).toHaveLength(Math.min(count, 34) - 3))
    await catalog.closeAll()
    expect(publications).toBeLessThanOrEqual(Math.min(count, 34))
    expect(
      children.some((child) =>
        [2, 3, 4].some((index) => child.launch.cwd === join(root, 'work', `context-${index}`))
      )
    ).toBe(false)
    expect(children.every((child) => child.closes === 1 && child.exited)).toBe(true)
    expect(await readdir(join(root, 'acp-command-sessions', 'omp'))).toEqual([])
  }
)

it('answers before slow close, cancels queued deadlines and drains stop without launching waiters', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const close = deferred<void>()
  const { catalog, children } = await rig((child) => {
    const prove = child.proveClose
    child.proveClose = async () => {
      await close.promise
      return prove()
    }
  })
  expect(await catalog.settled(ompRecord('one'), 1_000)).toBeDefined()
  expect(await catalog.settled(ompRecord('two'), 1_000)).toBeDefined()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const queued = catalog.settled(ompRecord('queued'), 10_000)
  await vi.advanceTimersByTimeAsync(9_000)
  expect(await queued).toBeUndefined()
  const stop = catalog.closeAll()
  close.resolve()
  await stop
  expect(children).toHaveLength(2)
})

it.each(['unverifiable', null, 'live'] as const)(
  'releases exited roots with immutable tree=%s evidence so a third context can answer',
  async (tree) => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    const error = new Error('tree teardown unavailable')
    const evidence = Object.freeze({ root: 'exited' as const, tree })
    const { catalog, children, root } = await rig(
      (child) => {
        child.proveClose = async () => {
          child.evidence = evidence
          child.exit()
          if (tree === 'unverifiable') {
            throw error
          }
          return true
        }
      },
      { logger }
    )
    for (const id of ['one', 'two', 'three']) {
      expect(await catalog.settled(ompRecord(id), 1_000)).toBeDefined()
    }
    await catalog.closeAll()
    expect(children).toHaveLength(3)
    expect(
      children.every((child) => child.lastCloseResult === evidence && child.closes === 1)
    ).toBe(true)
    expect(await readdir(join(root, 'acp-command-sessions', 'omp'))).toEqual([])
    expect(logger.warn.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [
        'ACP command discovery close evidence',
        {
          scope: 'acp-command-discovery',
          result: evidence,
          error: tree === 'unverifiable' ? error : undefined
        }
      ])
    )
  }
)

it.each([
  ['live', 'exited'],
  ['unverifiable', 'exited'],
  ['live', 'unverifiable']
] as const)(
  'retains root=%s with historical tree=%s until genuine exit, then drains cleanup once',
  async (root, tree) => {
    const evidence = Object.freeze({ root, tree })
    const { catalog, children } = await rig((child) => {
      vi.spyOn(child, 'rootVerdict', 'get').mockImplementation(() =>
        child.exited ? 'exited' : root
      )
      vi.spyOn(child, 'onExit')
      child.proveClose = async () => {
        child.evidence = evidence
        return false
      }
    })
    await catalog.settled(ompRecord('one'), 1_000)
    await catalog.settled(ompRecord('two'), 1_000)
    catalog.read(ompRecord('three'))
    await tick()
    expect(children).toHaveLength(2)
    await expect(catalog.closeAll()).rejects.toThrow(/could not prove/)
    const folders = children.map((child) => child.launch.args.at(-1)!)
    await Promise.all(folders.map((folder) => access(folder)))
    children.forEach((child) => child.agent.close())
    expect(children.every((child) => child.rootVerdict === root)).toBe(true)
    const cleanup = deferred<void>()
    const remove = vi
      .mocked(fs.rm)
      .mockClear()
      .mockImplementation(async (...args) => {
        await cleanup.promise
        return rm(...args)
      })
    for (const child of children) {
      child.exit()
      vi.mocked(child.onExit).mock.calls[0]![0]({ code: 0, signal: null, processless: false })
      expect(child.lastCloseResult).toBe(evidence)
    }
    let drained = false
    const stop = catalog.closeAll().then(() => {
      drained = true
    })
    await tick()
    expect(drained).toBe(false)
    cleanup.resolve()
    await stop
    await catalog.closeAll()
    expect(remove.mock.calls.map(([folder]) => folder)).toEqual(folders)
    for (const folder of folders) {
      await expect(access(folder)).rejects.toThrow()
    }
    expect(children).toHaveLength(2)
    expect(
      children.every((child) => child.closes === 1 && child.lastCloseResult === evidence)
    ).toBe(true)
  }
)

it('handles actual root exit just before listener registration without changing historical evidence', async () => {
  const evidence = Object.freeze({ root: 'live' as const, tree: 'unverifiable' as const })
  const { catalog, children, root } = await rig((child) => {
    const onExit = child.onExit.bind(child)
    vi.spyOn(child, 'onExit').mockImplementation((listener) => {
      child.exit()
      onExit(listener)
    })
    child.proveClose = async () => {
      child.evidence = evidence
      return false
    }
  })
  expect(await catalog.settled(ompRecord(), 1_000)).toBeDefined()
  await catalog.closeAll()
  expect(children[0]!.lastCloseResult).toBe(evidence)
  expect(children[0]!.closes).toBe(1)
  expect(await readdir(join(root, 'acp-command-sessions', 'omp'))).toEqual([])
})

it('delivers eight healthy contexts through three queued failures using due reads, with two owners through close', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  let held = 0
  let peak = 0
  const dispatches: number[] = []
  const closeGates: ReturnType<typeof deferred<void>>[] = []
  const { catalog, children, root } = await rig((child) => {
    dispatches.push(Date.now())
    peak = Math.max(peak, ++held)
    child.agent.on('session/new', (frame) => {
      child.agent.reply(frame, { sessionId: DISCOVERY_SESSION })
      setTimeout(
        () =>
          child.agent.notify('session/update', {
            sessionId: DISCOVERY_SESSION,
            update: capture.enabled
          }),
        8_000
      )
    })
    const prove = child.proveClose
    const close = deferred<void>()
    child.proveClose = async () => {
      closeGates.push(close)
      await close.promise
      const result = await prove()
      held--
      return result
    }
  })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(0)
  const records = Array.from({ length: 8 }, (_, index) => ompRecord(`healthy-${index}`))
  const changed = vi.fn(() => records.forEach((record) => catalog.read(record)))
  catalog.onChange(changed)
  for (let wave = 0; wave < 4; wave++) {
    const answers = records.map((record) => catalog.settled(record, 10_000))
    await waitFor(() => expect(children).toHaveLength((wave + 1) * 2))
    await waitFor(() =>
      expect(children.every((child) => child.agent.frames.at(-1)?.method === 'session/new')).toBe(
        true
      )
    )
    await vi.advanceTimersByTimeAsync(8_000)
    await waitFor(() => expect(changed).toHaveBeenCalledTimes((wave + 1) * 2))
    await waitFor(() => expect(closeGates).toHaveLength(2))
    expect(held).toBe(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await Promise.all(answers)).filter(Boolean)).toHaveLength((wave + 1) * 2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(Date.now()).toBe(wave * 19_000 + 11_000)
    expect(held).toBe(2)
    closeGates.splice(0).forEach((close) => close.resolve())
    await waitFor(() => expect(held).toBe(0))
    await waitFor(async () =>
      expect(await readdir(join(root, 'acp-command-sessions', 'omp'))).toEqual([])
    )
    if (wave < 3) {
      await vi.advanceTimersByTimeAsync(8_000)
    }
  }
  expect(dispatches).toEqual([0, 0, 19_000, 19_000, 38_000, 38_000, 57_000, 57_000])
  expect(Date.now()).toBe(68_000)
  expect(peak).toBe(2)
  expect(
    records.every((record) => catalog.read(record)?.some((row) => row.name === 'skill:plan'))
  ).toBe(true)
  await catalog.closeAll()
  expect(children.every((child) => child.closes === 1 && child.exited)).toBe(true)
})

it.each(['missing', 'file'] as const)(
  'retains native rows for a %s physical cwd and recovers at the next ten-second read',
  async (kind) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let cwd = ''
    const { catalog, children, root, workspacePath } = await rig(undefined, {
      resolveWorkspacePath: async () => cwd
    })
    cwd = workspacePath('physical')
    await mkdir(cwd, { recursive: true })
    const record = ompRecord()
    const rows = await catalog.settled(record, 1_000)
    expect(rows).toBeDefined()
    const changed = vi.fn()
    catalog.onChange(changed)
    cwd = join(root, 'restored')
    if (kind === 'file') {
      await writeFile(cwd, 'not a directory')
    }
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    await vi.advanceTimersByTimeAsync(AT_REST_COMMANDS_TTL_MS)
    expect(await catalog.settled(record, 10_000)).toEqual(rows)
    expect(children).toHaveLength(1)
    expect(changed).not.toHaveBeenCalled()
    if (kind === 'file') {
      await rm(cwd)
    }
    await mkdir(cwd)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(catalog.read(record)).toEqual(rows)
    expect(children).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await catalog.settled(record, 10_000)).toEqual(rows)
    expect(children).toHaveLength(2)
    expect(children[1]!.launch.cwd).toBe(cwd)
    expect(changed).not.toHaveBeenCalled()
    await catalog.closeAll()
  }
)

it('retains hour-unread native rows across unrelated reads and a failed slow refresh', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  let reports = true
  const { catalog, children } = await rig((child) => {
    child.agent.on('session/new', (frame) => {
      if (reports) {
        child.agent.notify('session/update', {
          sessionId: DISCOVERY_SESSION,
          update: capture.enabled
        })
      }
      child.agent.reply(frame, { sessionId: DISCOVERY_SESSION })
    })
  })
  const record = ompRecord('unread')
  const rows = await catalog.settled(record, 1_000)
  expect(rows).toBeDefined()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  await vi.advanceTimersByTimeAsync(3_600_001)
  expect(await catalog.settled(ompRecord('unrelated'), 10_000)).toEqual(rows)
  reports = false
  expect(catalog.read(record)).toEqual(rows)
  const refresh = catalog.settled(record, 10_000)
  await waitFor(() => expect(children).toHaveLength(3))
  await vi.advanceTimersByTimeAsync(9_000)
  expect(await refresh).toEqual(rows)
  await catalog.closeAll()
})

it.each([10, 100])(
  'bounds repeated failed demand at %i contexts without failure broadcasts or query spawns',
  async (count) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const originalAcquire = PrioritySemaphore.prototype.acquire
    const admissions = new Set<symbol>()
    const acquire = vi
      .spyOn(PrioritySemaphore.prototype, 'acquire')
      .mockImplementation(async function (this: PrioritySemaphore, priority, signal) {
        const request = Symbol()
        admissions.add(request)
        try {
          const release = await originalAcquire.call(this, priority, signal)
          return () => {
            release()
            admissions.delete(request)
          }
        } catch (error) {
          admissions.delete(request)
          throw error
        }
      })
    const stat = vi.mocked(fs.stat)
    let peak = 0
    let reports = true
    const closeGates: ReturnType<typeof deferred<void>>[] = []
    const { catalog, children, root } = await rig((child) => {
      if (!reports) {
        const prove = child.proveClose
        const close = deferred<void>()
        closeGates.push(close)
        child.proveClose = async () => {
          await close.promise
          return prove()
        }
      }
      peak = Math.max(peak, children.filter((owner) => !owner.exited).length)
      child.agent.on('session/new', (frame) => {
        if (reports) {
          child.agent.notify('session/update', {
            sessionId: DISCOVERY_SESSION,
            update: capture.enabled
          })
        }
        child.agent.reply(frame, { sessionId: DISCOVERY_SESSION })
      })
    })
    try {
      const records = Array.from({ length: count }, (_, index) => ompRecord(`failure-${index}`))
      for (const record of records) {
        expect(await catalog.settled(record, 1_000)).toBeDefined()
      }
      const rows = catalog.read(records[0]!)!
      await waitFor(async () =>
        expect(await readdir(join(root, 'acp-command-sessions', 'omp'))).toEqual([])
      )
      await waitFor(() => expect(admissions.size).toBe(0))
      acquire.mockClear()
      stat.mockClear()
      reports = false
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      await vi.advanceTimersByTimeAsync(AT_REST_COMMANDS_TTL_MS)
      const changed = vi.fn(() => records.forEach((record) => catalog.read(record)))
      catalog.onChange(changed)
      for (let wave = 1; wave <= 3; wave++) {
        const answers = records.map((record) => catalog.settled(record, 10_000))
        records.forEach((record) => expect(catalog.read(record)).toEqual(rows))
        await waitFor(() => expect(children).toHaveLength(count + wave * 2))
        await waitFor(() =>
          expect(
            children.every((child) => child.agent.frames.at(-1)?.method === 'session/new')
          ).toBe(true)
        )
        expect(stat).toHaveBeenCalledTimes(wave * count)
        expect(acquire).toHaveBeenCalledTimes(wave * Math.min(count, 34))
        expect(children.filter((child) => !child.exited)).toHaveLength(2)
        await vi.advanceTimersByTimeAsync(9_000)
        expect(await Promise.all(answers)).toEqual(records.map(() => rows))
        // Settle every queued deadline before close can release capacity within this wave.
        expect(children.filter((child) => !child.exited)).toHaveLength(2)
        expect(admissions.size).toBe(2)
        closeGates.splice(0).forEach((close) => close.resolve())
        await waitFor(async () =>
          expect(await readdir(join(root, 'acp-command-sessions', 'omp'))).toEqual([])
        )
        await waitFor(() => expect(admissions.size).toBe(0))
        expect(changed).not.toHaveBeenCalled()
        for (let query = 0; query < count; query++) {
          expect(
            buildNativeChatPickerItems([], [], 'skill:pl', '/', sessionReportedSkills(rows, 'omp'))
          ).toEqual(expect.arrayContaining([expect.objectContaining({ token: '/skill:plan' })]))
        }
        expect(stat).toHaveBeenCalledTimes(wave * count)
        expect(children).toHaveLength(count + wave * 2)
        // Overflow fails before queued deadlines; the next demand is due for every context.
        await vi.advanceTimersByTimeAsync(10_000)
      }
      await catalog.closeAll()
      expect(peak).toBe(2)
      expect(children.every((child) => child.exited && child.closes === 1)).toBe(true)
    } finally {
      closeGates.splice(0).forEach((close) => close.resolve())
      await catalog.closeAll()
    }
  }
)
