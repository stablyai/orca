// @vitest-environment happy-dom
import {
  directory,
  workspace,
  account,
  clock,
  store,
  host,
  deliveryAdapter,
  openHost,
  discoverWithoutUserHome,
  menuOf,
  namesOf,
  attachContext,
  runtime,
  renderer,
  advanceCatalogClock
} from './structured-agent-session-at-rest-command-rig.test-fixture'
import { act } from '@testing-library/react'

import {
  commandDiscoveryRig,
  DISCOVERY_SESSION
} from '../../acp/acp-command-discovery.test-fixture'

import { AtRestCommandCatalog } from './at-rest-command-catalog'
import { startAgentSessionCommandMenuQuery } from '../../../shared/agent-session-command-menu-query'
import { createCodexAtRestSkillCatalog } from '../../codex/codex-at-rest-skills-probe'
import {
  bindAtRestCommandContexts,
  retireAtRestCommandSettings,
  refreshAtRestCommandContext,
  retireAtRestCommandContext
} from './at-rest-command-context'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'

import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import {
  CLAUDE_AT_REST_COMMANDS_TTL_MS,
  ClaudeAtRestCommandCatalog
} from '../../claude/claude-at-rest-commands'
import { createClaudeCommandCatalogProbe } from '../../claude/claude-command-catalog-probe'
import type { runAgentModelCatalogListing } from '../agent-model-catalog/agent-model-catalog-probe-runner'

import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

type ListingCall = Parameters<typeof runAgentModelCatalogListing>

describe("a Claude chat whose Claude isn't running lists Claude's own `/` commands", () => {
  it('as Claude itself lists it in the chat’s folder, from the folders until it can, and keeps its list through a failed refresh', async () => {
    const asked: ListingCall[] = []
    const failed = '{"type":"control_response","response":{"subtype":"error"}}\n'
    const listed = `${JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'orca-command-discovery',
        response: {
          commands: [
            { name: 'goal', description: 'Set a goal', argumentHint: '', builtin: true },
            { name: 'review-pr', description: 'A skill (project)', argumentHint: '' }
          ]
        }
      }
    })}\n`
    let answer: string | Promise<string> = failed
    const probe = createClaudeCommandCatalogProbe({
      resolveCommand: () => ({ command: 'launcher', prefixArgs: ['run', '--', 'claude'] }),
      resolveInheritedEnv: async () => ({ PATH: '/bin' }),
      resolveAuthPolicy: () => ({ account: 'system' }),
      runListing: async (...call) => {
        asked.push(call)
        return answer
      }
    })
    const catalog = new ClaudeAtRestCommandCatalog({
      resolveWorkspacePath: async () => workspace,
      now: () => clock,
      probe,
      discover: discoverWithoutUserHome
    })
    const record = () => store.getRecord(SESSION)!
    const commandNames = () => namesOf(catalog.read(record()) ?? null, 'command')
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await host.flushAllStreamedEvents()
      await openHost(catalog)
      expect(namesOf(await menuOf(SESSION), 'command')).toEqual([
        'model',
        'effort',
        'clear',
        'compact',
        'deploy'
      ])
      const success = Promise.withResolvers<string>()
      answer = success.promise
      advanceCatalogClock(CLAUDE_AT_REST_COMMANDS_TTL_MS)
      host.readCommands(SESSION)
      await vi.waitFor(() => expect(asked).toHaveLength(2))
      // A slow refresh is joined, not doubled, however long it runs.
      advanceCatalogClock(30_000)
      host.readCommands(SESSION)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(asked).toHaveLength(2)
      success.resolve(listed)
      await vi.waitFor(() => expect(commandNames()).toContain('goal'))
      const claudeList = catalog.read(record())
      expect(claudeList?.find((entry) => entry.name === 'goal')).toMatchObject({
        kind: 'command',
        description: 'Set a goal'
      })
      expect(asked[0]?.[0]).toMatchObject({
        command: 'launcher',
        cwd: workspace
      })
      expect(asked[0]?.[0].args.slice(0, 3)).toEqual(['run', '--', 'claude'])
      expect(asked[0]?.[0].stdin).toContain('orca-command-discovery')
      expect(asked[0]?.[1].inheritedEnv?.CLAUDE_CONFIG_DIR).toBe(account)
      // Failed refresh must retain the provider list over folder fallback.
      answer = failed
      advanceCatalogClock(CLAUDE_AT_REST_COMMANDS_TTL_MS)
      host.readCommands(SESSION)
      await vi.waitFor(() => expect(warned).toHaveBeenCalledTimes(2))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(asked).toHaveLength(3)
      expect(catalog.read(record())).toEqual(claudeList)
      // The folder answer still counts as this TTL's scan.
      advanceCatalogClock(CLAUDE_AT_REST_COMMANDS_TTL_MS - 1)
      host.readCommands(SESSION)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(asked).toHaveLength(3)
    } finally {
      warned.mockRestore()
    }
  })
  it('cancels source preparation, fallback and close before any late work', async () => {
    vi.useFakeTimers()
    const listed = (name: string) =>
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'orca-command-discovery',
          response: { commands: [{ name, description: name, argumentHint: '', builtin: true }] }
        }
      })}\n`
    let pending = Promise.withResolvers<string>()
    let fallback = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>()
    let stage = '',
      blocked = false
    const block = async <T>(at: string, value: T): Promise<T> => {
      if (stage.endsWith(at) && !blocked) {
        blocked = true
        entered.resolve()
        await pending.promise
      }
      return value
    }
    const asked: unknown[][] = []
    const probe = createClaudeCommandCatalogProbe({
      resolveCommand: () => ({ command: 'claude', prefixArgs: [] }),
      resolveInheritedEnv: () => block('environment', { PATH: '/bin' }),
      resolveAuthPolicy: () => ({ account: 'system' }),
      runListing: async (...call) => {
        asked.push(call)
        if (stage.endsWith('fallback') && !blocked) {
          throw new Error('CLI failed')
        }
        if (stage.endsWith('close') && !blocked) {
          entered.resolve()
          try {
            await waitForPromiseWithSignal(pending.promise, call[1].signal)
          } finally {
            await fallback.promise
          }
        }
        return listed('recovered')
      }
    })
    const emptyDiscovery = { skills: [], sources: [], scannedAt: 0 }
    const claude = new ClaudeAtRestCommandCatalog({
      resolveWorkspacePath: async () => workspace,
      resolveAccountHome: () =>
        block('account', { variable: 'CLAUDE_CONFIG_DIR' as const, path: account }),
      probe,
      discover: async (args) =>
        waitForPromiseWithSignal(block('fallback', emptyDiscovery), args.signal)
    })
    const codex = createCodexAtRestSkillCatalog({
      resolveWorkspacePath: () => block('workspace', workspace),
      resolveEnvironment: () => block('environment', { PATH: '/bin' }),
      resolveLaunchArgs: () => block('arguments', []),
      resolveCommand: () => ({ command: '/bin/codex', prefixArgs: [] }),
      runSession: async (invocation, body) => {
        asked.push([invocation])
        return body({
          request: async () => ({ data: [{ cwd: workspace, skills: [] }] }),
          notify: () => {}
        })
      }
    })
    const record = store.getRecord(SESSION)!
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      for (stage of [
        'codex/readiness',
        'codex/workspace',
        'codex/environment',
        'codex/arguments',
        'claude/account',
        'claude/environment',
        'claude/fallback',
        'claude/close'
      ]) {
        pending = Promise.withResolvers<string>()
        fallback = Promise.withResolvers<void>()
        entered = Promise.withResolvers<void>()
        blocked = false
        const provider = stage.startsWith('codex') ? ('codex' as const) : ('claude' as const)
        const catalog = provider === 'codex' ? codex : claude
        const chat = { ...record, provider }
        const ready = stage.endsWith('readiness')
          ? refreshAtRestCommandContext(() => block('readiness', undefined))
          : Promise.resolve()
        catalog.retireContext()
        const starting = asked.length
        catalog.read(chat)
        await entered.promise
        if (stage.endsWith('close')) {
          for (const workspaceId of ['two', 'three']) {
            catalog.read({ ...chat, location: { ...chat.location, workspaceId } })
          }
          await vi.waitFor(() => expect(asked).toHaveLength(starting + 2))
        }
        await vi.advanceTimersByTimeAsync(300_000)
        const before = asked.length
        blocked = true
        pending.resolve(listed('late'))
        fallback.resolve()
        await ready
        await vi.advanceTimersByTimeAsync(0)
        expect(asked).toHaveLength(before)
        expect(catalog.read(chat)).toBeUndefined()
        await vi.advanceTimersByTimeAsync(10_000)
        expect(await catalog.settled(chat, 1_000)).toBeDefined()
        expect(asked).toHaveLength(before + 1)
      }
      expect(warned).toHaveBeenCalledTimes(11)
    } finally {
      fallback.resolve()
      codex.dispose()
      claude.dispose()
      warned.mockRestore()
      vi.useRealTimers()
    }
  })
})

it('returns pending after the phone budget and hints a later completion without starting closed contexts', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const held = Promise.withResolvers<AgentSessionSlashCommand[]>()
  const entered = Promise.withResolvers<void>()
  const catalog = new ClaudeAtRestCommandCatalog({
    resolveWorkspacePath: async () => workspace,
    probe: async () => {
      entered.resolve()
      return held.promise
    }
  })
  const frames: AgentSessionSubscribeEvent[] = []
  let stop = () => {}
  try {
    await openHost(catalog)
    stop = await host.subscribe({
      id: 'phone',
      sessionId: SESSION,
      boundedFrames: true,
      commandsOnRequest: true,
      emit: (event) => frames.push(event)
    })
    frames.length = 0
    const reply = host.readCommands(SESSION, true)
    await entered.promise
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await reply).toEqual({ commands: undefined, commandsPending: true })
    await vi.advanceTimersByTimeAsync(2_000)
    held.resolve([{ name: 'plugin:check', kind: 'command' }])
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.type !== 'end' && frame.commandsChanged)).toBe(true)
    )
    expect(frames.every((frame) => !('commands' in frame))).toBe(true)
    expect(await host.readCommands(SESSION, true)).toEqual({
      commands: [{ name: 'plugin:check', kind: 'command' }],
      commandsPending: false
    })
    frames.length = 0
    catalog.retireContext()
    await vi.advanceTimersByTimeAsync(0)
    expect(frames.some((frame) => frame.type !== 'end' && frame.commandsChanged)).toBe(true)
    expect(catalog.snapshot(store.getRecord(SESSION)!).commandsPending).toBe(false)
  } finally {
    held.resolve([])
    stop()
    catalog.dispose()
    vi.useRealTimers()
  }
})

it.each([undefined, null] as const)(
  'settles cold failures under source cap %s through the real query and host',
  async (maxFailedScans) => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let scans = 0
    const catalog = new AtRestCommandCatalog({
      label: 'test',
      accepts: () => true,
      resolveWorkspacePath: async () => workspace,
      maxFailedScans,
      scan: async () => {
        scans++
        throw new Error('private provider detail')
      }
    })
    await openHost(catalog)
    const accept = vi.fn()
    const read = vi.fn(() => host.readCommands(SESSION, true))
    const query = startAgentSessionCommandMenuQuery(read, accept)
    await vi.waitFor(() => expect(scans).toBe(1), { interval: 0 })
    for (let index = 0; index < 2; index++) {
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => expect(scans).toBe(index + 2), { interval: 0 })
    }
    await vi.advanceTimersByTimeAsync(600_000)
    expect(scans).toBe(3)
    expect(read).toHaveBeenCalledTimes(3)
    if (maxFailedScans === null) {
      expect(accept).not.toHaveBeenCalled()
    } else {
      expect(accept).toHaveBeenLastCalledWith({ commands: undefined, commandsPending: false })
    }
    query.dispose()
    catalog.dispose()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
)

it.each([undefined, [], [{ name: 'fast', kind: 'command' as const }]])(
  'returns current retained/live %j and keeps retryable failure separate from pending',
  async (rows) => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let failing = rows === undefined
    let result = rows
    let scanGate: Promise<void> | undefined,
      entered: ReturnType<typeof Promise.withResolvers<void>> | undefined
    const catalog = new AtRestCommandCatalog({
      label: 'test',
      accepts: () => true,
      resolveWorkspacePath: async () => workspace,
      scan: async () => {
        entered?.resolve()
        await scanGate
        if (failing) {
          throw new Error('private provider detail')
        }
        return { commands: result, fromAgent: true }
      }
    })
    await openHost(catalog)
    if (rows === undefined) {
      await expect(host.readCommands(SESSION, true)).rejects.toThrow(
        'Command discovery unavailable'
      )
      expect(await host.readCommands(SESSION)).toEqual({ commands: undefined })
      failing = false
      result = [{ name: 'fast', kind: 'command' }]
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await host.readCommands(SESSION, true)).toEqual({
        commands: result,
        commandsPending: false
      })
    } else {
      expect(await host.readCommands(SESSION, true)).toEqual({
        commands: rows,
        commandsPending: false
      })
      failing = true
      await vi.advanceTimersByTimeAsync(300_000)
      expect(await host.readCommands(SESSION, true)).toEqual({
        commands: rows,
        commandsPending: false
      })
      // A newly mounted reader uses host-retained rows, not a client fallback.
      expect(await host.readCommands(SESSION, true)).toEqual({
        commands: rows,
        commandsPending: false
      })
    }
    catalog.retireContext()
    const held = Promise.withResolvers<void>()
    const live = vi.spyOn(deliveryAdapter, 'readCommands').mockReturnValue(undefined)
    scanGate = held.promise
    entered = Promise.withResolvers<void>()
    failing = true
    const waiting = host.readCommands(SESSION, true)
    await entered.promise
    live.mockReturnValue(rows ?? [])
    held.resolve()
    expect(await waiting).toEqual({ commands: rows ?? [], commandsPending: false })
    catalog.dispose()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
)

it.each(['claude', 'omp'] as const)(
  'delivers %s retirement through router, live reader, demanded query and host settlement after rejection parking',
  async (provider) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    let online = false
    let calls = 0,
      frames = 0
    const catalog =
      provider === 'claude'
        ? new ClaudeAtRestCommandCatalog({
            resolveWorkspacePath: async () => workspace,
            probe: async () => [{ name: 'fast', kind: 'command' }]
          })
        : undefined
    const omp =
      provider === 'omp'
        ? await commandDiscoveryRig((child) => {
            child.agent.on('session/new', (frame) => {
              child.agent.notify('session/update', {
                sessionId: DISCOVERY_SESSION,
                update: {
                  sessionUpdate: 'available_commands_update',
                  availableCommands: [{ name: 'fast', description: 'Fast', input: { hint: '' } }]
                }
              })
              child.agent.reply(frame, { sessionId: DISCOVERY_SESSION })
            })
          })
        : undefined
    const source = catalog ?? omp!.catalog
    const unbind = bindAtRestCommandContexts([source])
    await openHost(source)
    const id = await attachContext(provider, 101)
    runtime.call.mockImplementation(async (_target, method, params) => {
      if (method === 'agentSession.history') {
        return host.history(params)
      }
      calls++
      if (!online) {
        throw new Error('offline')
      }
      return host.readCommands(params.sessionId, true)
    })
    runtime.subscribe.mockImplementation(async (_target, params, emit) => ({
      unsubscribe: await host.subscribe({
        id: 'live-menu',
        ...params,
        commandsOnRequest: true,
        emit: (event) => {
          frames++
          emit(event)
        }
      })
    }))
    const menu = renderer.renderCommandMenu(id)
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50)
      })
      await act(async () => menu.setOpen(true))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(330_000)
      })
      expect(calls).toBe(3)
      expect(source.snapshot(store.getRecord(id)!).commands).toBeUndefined()
      online = true
      retireAtRestCommandSettings(['agentCmdOverrides'])
      await vi.advanceTimersByTimeAsync(50)
      await vi.waitFor(
        () =>
          expect(
            source.snapshot(store.getRecord(id)!).commands?.some((row) => row.name === 'fast')
          ).toBe(true),
        { interval: 0 }
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50)
      })
      expect(menu.commands()?.some((row) => row.name === 'fast')).toBe(true)
      expect(calls).toBe(4)
      await vi.advanceTimersByTimeAsync(600_000)
      expect(calls).toBe(4)
      const baseline = frames
      // Unchanged ordinary reads/completions do not masquerade as retirement.
      await host.readCommands(id, true)
      await vi.advanceTimersByTimeAsync(50)
      expect(frames).toBe(baseline)
      await refreshAtRestCommandContext(async () => {})
      await vi.advanceTimersByTimeAsync(50)
      await vi.waitFor(() => expect(calls).toBe(5), { interval: 0 })
      act(() => menu.setOpen(false))
      retireAtRestCommandSettings(['agentCmdOverrides'])
      await vi.advanceTimersByTimeAsync(50)
      expect(calls).toBe(5)
    } finally {
      menu.unmount()
      unbind()
      await omp?.dispose()
      vi.useRealTimers()
    }
  }
)

it.each([false, true])(
  'returns cached rows with pending=%s without inventing absence',
  async (empty) => {
    vi.useFakeTimers()
    const rows = empty ? [] : [{ name: 'fast', kind: 'command' as const }]
    let gate: Promise<void> | undefined
    const entered = Promise.withResolvers<void>(),
      held = Promise.withResolvers<void>()
    const catalog = new AtRestCommandCatalog({
      label: 'pending',
      accepts: () => true,
      resolveWorkspacePath: async () => workspace,
      scan: async () => {
        entered.resolve()
        await gate
        return { commands: rows, fromAgent: true }
      }
    })
    await openHost(catalog)
    await host.readCommands(SESSION, true)
    await vi.advanceTimersByTimeAsync(300_000)
    gate = held.promise
    const waiting = host.readCommands(SESSION, true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await waiting).toEqual({ commands: rows, commandsPending: true })
    held.resolve()
    expect(await host.readCommands(SESSION, true)).toEqual({
      commands: rows,
      commandsPending: false
    })
    catalog.dispose()
    vi.useRealTimers()
  }
)

it('retires absent contexts by provider/workspace independently of ordinary null publications and waits for readiness', async () => {
  vi.useFakeTimers()
  let starts = 0
  const catalog = new ClaudeAtRestCommandCatalog({
    resolveWorkspacePath: async () => workspace,
    probe: async () => {
      starts++
      return []
    }
  })
  await openHost(catalog)
  const ids = [
    await attachContext('claude', 21),
    await attachContext('claude', 22),
    await attachContext('omp', 23)
  ]
  const events = ids.map<AgentSessionSubscribeEvent[]>(() => [])
  const stops = await Promise.all(
    ids.map((sessionId, index) =>
      host.subscribe({
        id: `scope-${index}`,
        sessionId,
        commandsOnRequest: true,
        emit: (event) => events[index]!.push(event)
      })
    )
  )
  const unbind = bindAtRestCommandContexts([catalog])
  try {
    events.forEach((list) => list.splice(0))
    for (let index = 0; index < 2; index++) {
      retireAtRestCommandContext('workspace-21')
      await vi.advanceTimersByTimeAsync(0)
      expect(events[0]).toHaveLength(index + 1)
      expect(events.slice(1).map((list) => list.length)).toEqual([0, 0])
      expect(starts).toBe(0)
    }
    const barrier = Promise.withResolvers<void>()
    const ready = refreshAtRestCommandContext(() => barrier.promise)
    await vi.advanceTimersByTimeAsync(0)
    const read = host.readCommands(ids[0]!, true)
    await vi.advanceTimersByTimeAsync(1)
    expect(starts).toBe(0)
    barrier.resolve()
    await ready
    expect(await read).toMatchObject({ commands: [], commandsPending: false })
    expect(starts).toBe(1)
    expect(events[2]).toHaveLength(0)
  } finally {
    stops.forEach((stop) => stop())
    unbind()
    vi.useRealTimers()
  }
})

it('follows retired ownership to replacement data and rejects a late old publication', async () => {
  const entered = Promise.withResolvers<void>(),
    stale = Promise.withResolvers<void>()
  let scans = 0
  const catalog = new AtRestCommandCatalog({
    label: 'replacement',
    accepts: () => true,
    resolveWorkspacePath: async () => workspace,
    scan: async () => {
      if (++scans === 1) {
        entered.resolve()
        await stale.promise
        return { commands: [{ name: 'obsolete', kind: 'command' }], fromAgent: true }
      }
      return { commands: [{ name: 'fast', kind: 'command' }], fromAgent: true }
    }
  })
  await openHost(catalog)
  const old = host.readCommands(SESSION, true)
  await entered.promise
  catalog.retireContext()
  const current = host.readCommands(SESSION, true)
  expect(await current).toEqual({
    commands: [{ name: 'fast', kind: 'command' }],
    commandsPending: false
  })
  stale.resolve()
  expect(await old).toEqual(await current)
  expect(catalog.snapshot(store.getRecord(SESSION)!).commands).toEqual([
    { name: 'fast', kind: 'command' }
  ])
  catalog.dispose()
})

it.each(['no-source', 'unsupported', 'unavailable', 'missing'] as const)(
  'terminates %s as unknown without a timer or invented list',
  async (mode) => {
    vi.useFakeTimers()
    const scan = vi.fn(async () => ({ commands: undefined, fromAgent: false }))
    const catalog = new AtRestCommandCatalog({
      label: 'absence',
      accepts: () => mode !== 'unsupported',
      resolveWorkspacePath: async () =>
        mode === 'missing' ? join(directory, 'missing') : workspace,
      scan
    })
    await openHost(mode === 'no-source' ? null : catalog)
    const read = vi.fn(() => host.readCommands(SESSION, true)),
      accept = vi.fn()
    const query = startAgentSessionCommandMenuQuery(read, accept)
    await vi.waitFor(
      () => expect(accept).toHaveBeenCalledWith({ commands: undefined, commandsPending: false }),
      { interval: 0 }
    )
    await vi.advanceTimersByTimeAsync(600_000)
    expect(read).toHaveBeenCalledTimes(1)
    expect(scan).toHaveBeenCalledTimes(mode === 'unavailable' ? 1 : 0)
    query.dispose()
    catalog.dispose()
    vi.useRealTimers()
  }
)

it('parks actual unlimited ACP cold failures after three scans, including missing-workspace rejection', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const omp = await commandDiscoveryRig((child) =>
    child.agent.on('session/new', (frame) =>
      child.agent.reply(frame, { sessionId: DISCOVERY_SESSION })
    )
  )
  await openHost(omp.catalog)
  const id = await attachContext('omp', 201)
  const accept = vi.fn(),
    read = vi.fn(() => host.readCommands(id, true))
  const query = startAgentSessionCommandMenuQuery(read, accept)
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await vi.waitFor(() => expect(omp.children).toHaveLength(attempt), { interval: 0 })
      await vi.waitFor(
        () => expect(omp.children.at(-1)?.agent.frames.at(-1)?.method).toBe('session/new'),
        { interval: 0 }
      )
      await vi.advanceTimersByTimeAsync(9_000)
      if (attempt < 3) {
        await vi.advanceTimersByTimeAsync(10_000)
      }
    }
    await vi.advanceTimersByTimeAsync(600_000)
    expect(read).toHaveBeenCalledTimes(3)
    expect(accept).not.toHaveBeenCalled()
    const missing = await commandDiscoveryRig(undefined, {
      resolveWorkspacePath: async () => join(directory, 'missing')
    })
    try {
      await openHost(missing.catalog)
      await expect(host.readCommands(id, true)).rejects.toThrow('Command discovery unavailable')
      expect(missing.children).toHaveLength(0)
    } finally {
      await missing.dispose()
    }
  } finally {
    query.dispose()
    await omp.dispose()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

it('wakes the same demanded desktop after a real pending episode reaches its deadline', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const held = Promise.withResolvers<void>()
  let repaired = false,
    calls = 0
  const catalog = new AtRestCommandCatalog({
    label: 'pending',
    accepts: () => true,
    maxFailedScans: null,
    resolveWorkspacePath: async () => workspace,
    scan: async () => {
      if (!repaired) {
        await held.promise
      }
      return {
        commands: [{ name: repaired ? 'fast' : 'obsolete', kind: 'command' }],
        fromAgent: true
      }
    }
  })
  await openHost(catalog)
  const unbind = bindAtRestCommandContexts([catalog])
  runtime.call.mockImplementation(async (_target, method, params) => {
    if (method === 'agentSession.history') {
      return host.history(params)
    }
    calls++
    return host.readCommands(params.sessionId, true)
  })
  runtime.subscribe.mockImplementation(async (_target, params, emit) => ({
    unsubscribe: await host.subscribe({
      id: 'deadline-menu',
      ...params,
      commandsOnRequest: true,
      emit
    })
  }))
  const hook = renderer.renderCommandMenu(SESSION)
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    await act(async () => hook.setOpen(true))
    await vi.waitFor(
      () => expect(catalog.snapshot(store.getRecord(SESSION)!).commandsPending).toBe(true),
      { interval: 0 }
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(330_000)
    })
    const parked = calls
    expect(parked).toBeGreaterThan(3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100_000)
    })
    expect(calls).toBe(parked)
    repaired = true
    retireAtRestCommandSettings(['agentCmdOverrides'])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    await vi.waitFor(
      () => expect(catalog.snapshot(store.getRecord(SESSION)!).commands?.[0]?.name).toBe('fast'),
      { interval: 0 }
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(calls).toBe(parked + 1)
    expect(hook.commands()?.[0]?.name).toBe('fast')
  } finally {
    held.resolve()
    hook.unmount()
    unbind()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})
