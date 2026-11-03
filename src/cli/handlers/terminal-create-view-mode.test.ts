import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime-client'
import type { CliStatusResult } from '../../shared/runtime-types'
import { TERMINAL_CREATE_VIEW_MODE_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { TERMINAL_HANDLERS } from './terminal'

const CREATED = {
  result: { terminal: { handle: 'term_1', worktreeId: 'repo::/src/app', title: null } }
}

function viewModeClient(
  call: RuntimeClient['call'],
  runtime: CliStatusResult['runtime'] = {
    state: 'ready',
    reachable: true,
    runtimeId: 'runtime-1',
    capabilities: [TERMINAL_CREATE_VIEW_MODE_RUNTIME_CAPABILITY]
  }
): RuntimeClient {
  const client = new RuntimeClient('/tmp/orca-view-mode-test', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(call)
  vi.spyOn(client, 'getCliStatus').mockResolvedValue({
    id: 'status',
    ok: true,
    result: {
      app: { running: runtime.reachable, pid: runtime.reachable ? 123 : null },
      runtime,
      graph: { state: runtime.reachable ? 'ready' : 'not_running' }
    },
    _meta: { runtimeId: runtime.runtimeId ?? 'none' }
  })
  return client
}

function createTerminal(client: RuntimeClient, flags: [string, string][]) {
  return TERMINAL_HANDLERS['terminal create']({
    flags: new Map([['worktree', 'path:/src/app'], ...flags]),
    client,
    cwd: '/src/app',
    json: true
  })
}

const CHAT: [string, string][] = [
  ['command', './start-agent.sh'],
  ['view-mode', 'chat'],
  ['command-agent', 'claude']
]

const REFUSALS: [[string, string][], RegExp][] = [
  [[['view-mode', 'split']], /--view-mode must be one of/],
  [
    [
      ['command-agent', 'not-an-agent'],
      ['view-mode', 'chat']
    ],
    /Unknown TUI agent/
  ],
  [
    [
      ['view-mode', 'chat'],
      ['command-agent', 'claude']
    ],
    /pass --command/
  ],
  [
    [
      ['command', '  '],
      ['view-mode', 'chat'],
      ['command-agent', 'claude']
    ],
    /pass --command/
  ],
  [
    [
      ['command', 'claude'],
      ['view-mode', 'chat']
    ],
    /needs --command-agent/
  ],
  [
    [
      ['command', 'claude'],
      ['command-agent', 'claude']
    ],
    /pass --view-mode chat/
  ]
]

describe('terminal create --view-mode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('asks the host for a chat view of the named agent and keeps the command', async () => {
    const call = vi.fn().mockResolvedValue(CREATED)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await createTerminal(viewModeClient(call), CHAT)

    expect(call).toHaveBeenCalledWith(
      'terminal.create',
      expect.objectContaining({
        command: './start-agent.sh',
        viewMode: 'chat',
        commandAgent: 'claude'
      })
    )
    expect(call).not.toHaveBeenCalledWith(
      'terminal.create',
      expect.objectContaining({ launchAgent: expect.anything() })
    )
  })

  it('sends a create without the flags exactly as before', async () => {
    const call = vi.fn().mockResolvedValue(CREATED)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const client = viewModeClient(call)

    await createTerminal(client, [['command', 'claude']])

    const params = call.mock.calls.find(([method]) => method === 'terminal.create')?.[1]
    expect(params).not.toHaveProperty('viewMode')
    expect(params).not.toHaveProperty('commandAgent')
    expect(client.getCliStatus).not.toHaveBeenCalled()
  })

  it.each(REFUSALS)('refuses %j before contacting the host', async (flags, message) => {
    const call = vi.fn()

    await expect(createTerminal(viewModeClient(call), flags)).rejects.toThrow(message)
    expect(call).not.toHaveBeenCalledWith('terminal.create', expect.anything())
  })

  // An older host strips viewMode and opens a plain terminal that looks like success.
  it('refuses a host without view mode support, and an unreachable one, before creating', async () => {
    const call = vi.fn()
    const old = viewModeClient(call, {
      state: 'ready',
      reachable: true,
      runtimeId: 'runtime-old',
      capabilities: []
    })
    const unreachable = viewModeClient(call, {
      state: 'not_running',
      reachable: false,
      runtimeId: null
    })

    await expect(createTerminal(old, CHAT)).rejects.toMatchObject({ code: 'incompatible_runtime' })
    await expect(createTerminal(unreachable, CHAT)).rejects.toMatchObject({
      code: 'runtime_unavailable'
    })
    expect(call).not.toHaveBeenCalledWith('terminal.create', expect.anything())
  })

  it('lets an older host open a plain terminal for --view-mode terminal', async () => {
    const call = vi.fn().mockResolvedValue(CREATED)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const old = viewModeClient(call, {
      state: 'ready',
      reachable: true,
      runtimeId: 'runtime-old',
      capabilities: []
    })

    await createTerminal(old, [['view-mode', 'terminal']])

    expect(call).toHaveBeenCalledWith(
      'terminal.create',
      expect.objectContaining({ viewMode: 'terminal' })
    )
  })
})
