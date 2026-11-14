import { statSync } from 'node:fs'
import type * as fs from 'node:fs/promises'

import { afterEach, expect, it, vi } from 'vitest'
import capture from '../../../shared/__fixtures__/omp-native-commands.json'
import '../../../shared/priority-semaphore'
import {
  commandDiscoveryRig,
  DISCOVERY_SESSION,
  ompRecord
} from './testing/acp-command-discovery.test-fixture'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import { readAcpForkSupport } from '../capabilities/acp-fork-support'
import { agentSessionRecordFixture } from '../../native-chat/testing/agent-session-record-test-fixture'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    stat: vi.fn(async (path: Parameters<typeof fs.stat>[0]) => statSync(path)),
    rm: vi.fn(actual.rm)
  }
})

const rigs: Awaited<ReturnType<typeof commandDiscoveryRig>>[] = []

async function rig(...args: Parameters<typeof commandDiscoveryRig>) {
  const opened = await commandDiscoveryRig(...args)
  rigs.push(opened)
  return opened
}
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()))
  vi.restoreAllMocks()
})

it('observes pre-initialize reports, validates session identity and keeps the latest explicit empty', async () => {
  const { catalog, children, workspacePath } = await rig(
    (child) => {
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
    },
    {
      resolveCommandSettings: () => ({
        agentCmdOverrides: { omp: `"${process.execPath}" run -- omp` }
      })
    }
  )
  expect(await catalog.settled(ompRecord(), 1_000)).toEqual([])
  await catalog.closeAll()
  expect(children[0]!.launch).toMatchObject({
    command: process.execPath,
    cwd: workspacePath('workspace-1'),
    args: [
      'run',
      '--',
      'omp',
      'acp',
      '--plugin-dir',
      '/installed/plugin',
      '--session-dir',
      expect.any(String)
    ],
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

it('lists OpenCode 2 commands from a session it then deletes, and never starts OpenCode 1.x', async () => {
  const openCodeRecord = (provider: 'opencode' | 'opencode2') =>
    agentSessionRecordFixture({
      sessionId: `chat-${provider}`,
      provider,
      accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } },
      location: { workspaceId: 'workspace-1', workspaceKind: 'folder' }
    })
  // Recorded from `opencode acp` 2.1.2 with a global command/itx-plan.md.
  const reported = {
    sessionUpdate: 'available_commands_update',
    availableCommands: [
      { name: 'init', description: 'guided AGENTS.md setup' },
      { name: 'itx-plan', description: 'Plan an implementation' },
      { name: 'compact', description: 'Compact the session' }
    ]
  }
  const deleted: unknown[] = []
  const v2 = await rig(
    (child) => {
      child.agent.on('initialize', (frame) =>
        child.agent.reply(frame, {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { delete: {}, fork: {} } }
        })
      )
      child.agent.on('session/new', (frame) => {
        child.agent.reply(frame, { sessionId: DISCOVERY_SESSION })
        child.agent.notify('session/update', { sessionId: DISCOVERY_SESSION, update: reported })
      })
      child.agent.on('session/delete', (frame) => {
        deleted.push(frame.params)
        child.agent.reply(frame, {})
      })
    },
    { probeVersion: async () => ({ version: '2.1.2' }) },
    acpLaunchSpecFor('opencode2')!
  )
  const listed = await v2.catalog.settled(openCodeRecord('opencode2'), 1_000)
  expect(listed?.map((command) => command.name)).toEqual(['init', 'itx-plan', 'compact'])
  expect(deleted).toEqual([{ sessionId: DISCOVERY_SESSION }])
  expect(readAcpForkSupport('opencode2')).toBe('supported')

  const v1 = await rig(
    undefined,
    { probeVersion: async () => ({ version: '1.19.5' }) },
    acpLaunchSpecFor('opencode')!
  )
  expect(await v1.catalog.settled(openCodeRecord('opencode'), 1_000)).toBeUndefined()
  expect(v1.children).toHaveLength(0)
})
