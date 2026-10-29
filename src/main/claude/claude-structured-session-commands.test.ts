import { describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { ClaudeAtRestCommandCatalog } from './claude-at-rest-commands'
import {
  bindAtRestCommandContexts,
  retireAtRestCommandSettings
} from '../native-chat/agent-session-wire/at-rest-command-context'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  tick,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

describe('session command updates', () => {
  it('publishes changed catalogs exactly once while idle', async () => {
    const claude = fakeClaude()
    const changed = vi.fn()
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: {
        appendItem: vi.fn(),
        appendTombstone: vi.fn(),
        publish: changed
      }
    })
    changed.mockClear()
    expect(adapter.readCommands('session-1')).toBeUndefined()
    const frame = {
      type: 'system',
      subtype: 'commands_changed',
      session_id: PROVIDER_SESSION_ID,
      slash_commands: ['plugin:check', 'doctor'],
      skills: ['plugin:check'],
      terminal_slash_commands: ['doctor']
    }
    claude.connections[0].handlers.onMessage?.(frame)
    await tick()
    expect(adapter.readCommands('session-1')).toEqual([
      { name: 'plugin:check', kind: 'skill' },
      { name: 'doctor', kind: 'command' }
    ])
    expect(changed).toHaveBeenCalledTimes(1)
    claude.connections[0].handlers.onMessage?.(frame)
    await tick()
    expect(changed).toHaveBeenCalledTimes(1)
    claude.connections[0].handlers.onMessage?.({ ...frame, slash_commands: [] })
    await tick()
    expect(adapter.readCommands('session-1')).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
    await adapter.closeSession('session-1')
  })
})

it.each([
  { commands: [] },
  { commands: [{ name: 'project:check', description: 'Project command', argumentHint: '' }] }
])('seeds the pre-prompt catalog from control initialization: %j', async ({ commands }) => {
  const claude = fakeClaude({ initProof: 'session-start', initCommands: commands })
  const adapter = adapterFor(claude)
  try {
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    const described = commands[0]?.description
    expect(adapter.readCommands('session-1')).toEqual(
      commands.map(({ name, description }) => ({
        name,
        kind: 'command',
        kindUnspecified: true,
        ...(description ? { description } : {})
      }))
    )
    expect(claude.connections[0].sent).toEqual([])
    expect(claude.connections[0].calls.map(({ subtype }) => subtype)).toEqual([
      'initialize',
      'get_settings'
    ])
    claude.connections[0].handlers.onMessage?.({
      type: 'system',
      subtype: 'init',
      session_id: PROVIDER_SESSION_ID,
      slash_commands: ['project:check'],
      skills: ['project:check']
    })
    expect(adapter.readCommands('session-1')).toEqual([
      { name: 'project:check', kind: 'skill', ...(described ? { description: described } : {}) }
    ])
  } finally {
    await adapter.closeSession('session-1')
  }
})

it('keeps a buffered stream catalog newer than the initialization response', async () => {
  const claude = fakeClaude({ initProof: 'session-start', initCommands: [{ name: 'old' }] })
  const open = claude.openConnection
  claude.openConnection = async (...args) => {
    const connection = await open(...args)
    const getSettings = connection.getSettings
    connection.getSettings = async (...settingsArgs) => {
      args[1]?.onMessage?.({
        type: 'system',
        subtype: 'commands_changed',
        session_id: PROVIDER_SESSION_ID,
        commands: [{ name: 'fresh' }]
      })
      return getSettings(...settingsArgs)
    }
    return connection
  }
  const adapter = adapterFor(claude)
  try {
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    expect(adapter.readCommands('session-1')?.map(({ name }) => name)).toEqual(['fresh'])
  } finally {
    await adapter.closeSession('session-1')
  }
})

it("answers a resting chat's `/` menu only for chats this host runs", async () => {
  const listed = [{ name: 'review-pr', kind: 'skill' as const }]
  const catalog = new ClaudeAtRestCommandCatalog({
    resolveWorkspacePath: async () => process.cwd(),
    probe: async () => listed
  })
  const local = agentSessionRecordFixture()
  catalog.read(local)
  await vi.waitFor(() => expect(catalog.read(local)).toEqual(listed))

  // Same workspace and account on another host: only that host can read its folders.
  const remote = { ...local, location: { ...local.location, executionHostId: 'ssh:box' as const } }
  expect(catalog.read(remote)).toBeUndefined()
})

it("lists a resting chat's `/` menu from the account it would start on, following a switch", async () => {
  let selected = '/accounts/b'
  const probed: string[] = []
  const catalog = new ClaudeAtRestCommandCatalog({
    resolveWorkspacePath: async () => process.cwd(),
    resolveAccountHome: async () => ({ variable: 'CLAUDE_CONFIG_DIR', path: selected }),
    probe: async ({ accountHomePath }) => {
      probed.push(accountHomePath)
      return [{ name: accountHomePath, kind: 'skill' }]
    }
  })
  const release = bindAtRestCommandContexts([catalog])
  try {
    // Created on /home/user/.claude, but its next start uses the selected account.
    const chat = agentSessionRecordFixture()
    expect(await catalog.settled(chat, 1000)).toEqual([{ name: '/accounts/b', kind: 'skill' }])
    const createdOnB = {
      ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'created-on-b' })),
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/b' }
    }
    expect(await catalog.settled(createdOnB, 1000)).toEqual([
      { name: '/accounts/b', kind: 'skill' }
    ])
    expect(probed).toEqual(['/accounts/b'])

    selected = '/accounts/a'
    retireAtRestCommandSettings(['activeClaudeManagedAccountId'])
    expect(await catalog.settled(chat, 1000)).toEqual([{ name: '/accounts/a', kind: 'skill' }])
  } finally {
    release()
  }
})
