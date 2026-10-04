import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { supportsCursorStructuredLocation } from './cursor-structured-location-support'
import {
  createCursorStructuredLaunchResolver,
  cursorStructuredAccountHome
} from './cursor-structured-launch-resolution'

const account = join(tmpdir(), 'cursor-selected-account')
const cwd = join(tmpdir(), 'cursor-folder')
const input: StructuredAgentSessionAcquireInput = {
  identity: {
    sessionId: 'cursor-chat',
    workspaceId: 'folder',
    hostId: 'local',
    agent: 'cursor',
    providerHandle: { kind: 'cursor', sessionId: 'exact-provider-id' }
  },
  fence: 1,
  spawnToken: 'spawn-token'
}
function record(): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(agentSessionLeaseFixture()),
    sessionId: 'cursor-chat',
    provider: 'cursor',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder',
      workspaceKind: 'folder'
    },
    accountHome: { variable: 'CURSOR_CONFIG_DIR', path: account },
    providerHandleChain: [
      {
        linkId: 'cursor-link',
        handle: { provider: 'cursor', sessionId: 'exact-provider-id' },
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 1
      }
    ]
  }
}
function resolve(overrides: Partial<AgentSessionRecord> = {}, args = '') {
  return createCursorStructuredLaunchResolver({
    store: { getRecord: () => ({ ...record(), ...overrides }) },
    resolveWorkspacePath: async () => cwd,
    resolveEnvironment: async () => ({
      PATH: '',
      HOME: tmpdir(),
      CURSOR_CONFIG_DIR: 'ambient-account'
    }),
    resolveRecipe: () => ({
      command: 'custom-cursor --profile selected',
      args,
      env: { CURSOR_CONFIG_DIR: 'recipe-account', EXPLICIT: 'preserved' }
    })
  })(input)
}
describe('Cursor structured launch identity', () => {
  it.skipIf(!supportsCursorStructuredLocation(record().location))(
    'pins the selected account and exact provider ID while preserving configured argv and folder ownership',
    async () => {
      const launch = await resolve({}, '--endpoint https://example.invalid')
      expect(launch).toMatchObject({
        command: 'custom-cursor',
        args: ['--profile', 'selected', '--endpoint', 'https://example.invalid', 'acp'],
        cwd,
        resumeSessionId: 'exact-provider-id',
        env: {
          HOME: tmpdir(),
          CURSOR_CONFIG_DIR: account,
          EXPLICIT: 'preserved',
          ORCA_AGENT_SESSION_ID: 'cursor-chat',
          ORCA_STRUCTURED_SESSION: '1'
        }
      })
    }
  )
  it
    .skipIf(!supportsCursorStructuredLocation(record().location))
    .each(['--resume another', '--resume=another', '--continue', '--print', 'acp', '--'])(
    'refuses terminal-only arguments %s before spawning',
    async (args) => {
      await expect(resolve({}, args)).rejects.toThrow('terminal continuation arguments')
    }
  )
  it('never turns another host or WSL account into a local process', async () => {
    await expect(
      resolve({ location: { ...record().location, executionHostId: 'ssh:host' } })
    ).rejects.toThrow('execution host')
    await expect(
      resolve({ location: { ...record().location, wslDistro: 'Ubuntu' } })
    ).rejects.toThrow('execution host')
  })
  it('uses actual Cursor config-root precedence without assigning the user profile variable', () => {
    expect(
      cursorStructuredAccountHome({
        CURSOR_CONFIG_DIR: account,
        XDG_CONFIG_HOME: cwd,
        HOME: tmpdir()
      })
    ).toBe(account)
    expect(cursorStructuredAccountHome({ XDG_CONFIG_HOME: cwd, HOME: tmpdir() })).toBe(
      join(cwd, 'cursor')
    )
    expect(cursorStructuredAccountHome({ HOME: tmpdir() })).toBe(join(tmpdir(), '.cursor'))
  })
})
