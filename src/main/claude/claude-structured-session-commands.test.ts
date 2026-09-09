import { describe, expect, it, vi } from 'vitest'
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
    expect(adapter.readCommands('session-1')).toEqual([{ name: 'plugin:check', kind: 'skill' }])
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
    expect(adapter.readCommands('session-1')).toEqual(
      commands.map(({ name }) => ({ name, kind: 'command', kindUnspecified: true }))
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
    expect(adapter.readCommands('session-1')).toEqual([{ name: 'project:check', kind: 'skill' }])
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
