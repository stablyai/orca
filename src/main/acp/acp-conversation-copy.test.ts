import { afterEach, describe, expect, it, vi } from 'vitest'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { copyAcpConversation } from './acp-conversation-copy'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { OpenCodeCopyServerRouteError } from '../../shared/opencode-launch-command'
import {
  FakeAcpChild,
  openAcpAdapterRig,
  type AcpAdapterRig,
  PROVIDER_SESSION
} from './acp-structured-adapter.test-support'

vi.mock('../native-chat/session-file-resolver', () => ({
  resolveSessionFilePath: async () => '/account-a/sessions/copy-1.jsonl'
}))
const FORKS = { agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } } }
const input = {
  identity: {
    sessionId: 'orca-chat-1',
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'omp',
    providerHandle: null
  },
  providerSessionId: PROVIDER_SESSION,
  accountHome: { variable: 'PI_CODING_AGENT_DIR', path: '/account-a' }
}
const rigs: AcpAdapterRig[] = []
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.adapter.closeAll()))
  await closeProviderTimelineRigs()
})

async function open(agent: 'omp' | 'opencode' = 'omp') {
  const rig = await openAcpAdapterRig({
    spec: acpLaunchSpecFor(agent)!,
    initialize: FORKS,
    deps: { resolveLaunchArgs: () => ['--', '--server', 'literal-operand'] },
    launch: {
      command: 'launcher',
      prefixArgs: ['run', '--', agent],
      args: [
        'run',
        '--',
        agent,
        ...acpLaunchSpecFor(agent)!.args({ fullAccess: false, pluginDir: null })
      ]
    },
    script: (agent) =>
      agent.on('session/fork', (frame) => agent.reply(frame, { sessionId: 'copy-1' }))
  })
  rigs.push(rig)
  return rig
}

describe('copying a chat conversation for the CLI', () => {
  it.each(['omp', 'opencode'] as const)(
    'copies a stopped and running %s chat without loading or prompting its original',
    async (agent) => {
      const rig = await open(agent)
      const request = {
        ...input,
        identity: { ...input.identity, agent },
        accountHome:
          agent === 'omp'
            ? input.accountHome
            : { kind: 'opencode' as const, locator: { kind: 'unmanaged' as const } }
      }
      const expected = {
        sessionId: 'copy-1',
        ...(agent === 'omp' ? { filePath: '/account-a/sessions/copy-1.jsonl' } : {})
      }
      await expect(rig.adapter.copyConversation(request)).resolves.toEqual(expected)
      expect(rig.child().agent.frames.map((frame) => frame.method)).toEqual([
        'initialize',
        'session/fork'
      ])
      expect(rig.sent('session/fork')[0]?.params).toEqual({
        sessionId: PROVIDER_SESSION,
        cwd: '/workspace/project',
        mcpServers: []
      })
      expect(rig.child().closes).toBe(1)
      await rig.acquire()
      const chat = rig.child()
      const frames = [...chat.agent.frames]
      await expect(rig.adapter.copyConversation(request)).resolves.toEqual(expected)
      expect(chat.agent.frames).toEqual(frames)
      expect(chat.closes).toBe(0)
      expect(rig.child()).not.toBe(chat)
      expect(rig.child().closes).toBe(1)
    }
  )

  it('permits another copy after unproven cleanup and retries the retained child at shutdown', async () => {
    const rig = await openAcpAdapterRig({ spec: acpLaunchSpecFor('omp')!, initialize: FORKS })
    rigs.push(rig)
    const copying = rig.adapter.copyConversation(input)
    await vi.waitFor(() => expect(rig.sent('session/fork')).toHaveLength(1))
    const child = rig.child()
    child.proveClose = async () => false
    child.agent.reply(rig.sent('session/fork')[0]!, { sessionId: 'copy-1' })
    await expect(copying).resolves.toHaveProperty('sessionId', 'copy-1')
    const next = rig.adapter.copyConversation(input)
    await vi.waitFor(() => {
      expect(rig.child()).not.toBe(child)
      expect(rig.sent('session/fork')).toHaveLength(1)
    })
    rig.child().agent.reply(rig.sent('session/fork')[0]!, { sessionId: 'copy-2' })
    await expect(next).resolves.toHaveProperty('sessionId', 'copy-2')
    child.proveClose = async () => {
      child.exit()
      return true
    }
    await rig.adapter.closeAll()
    expect(child.closes).toBe(2)
  })

  it('cancels an unanswered fork after delivery and closes its temporary process', async () => {
    const children: FakeAcpChild[] = []
    const spec = acpLaunchSpecFor('omp')!
    const controller = new AbortController()
    const cancelled = new Error('copy cancelled')
    const copying = copyAcpConversation(
      {
        spec,
        dataDirectory: '/orca-data',
        readLaunch: async () => ({
          spec,
          command: 'fake',
          prefixArgs: [],
          args: [],
          cwd: '/repo',
          env: {},
          envToDelete: [],
          fullAccess: false,
          resume: null
        }),
        connect: (...args: ConstructorParameters<typeof FakeAcpChild>) => {
          const child = new FakeAcpChild(...args)
          child.agent.on('initialize', (frame) =>
            child.agent.reply(frame, { protocolVersion: 1, ...FORKS })
          )
          children.push(child)
          return child
        }
      },
      input,
      { signal: controller.signal, track: () => {} }
    )
    const outcome = copying.catch((error: unknown) => error)
    try {
      await vi.waitFor(() =>
        expect(
          children[0]?.agent.frames
            .filter((frame) => frame.method === 'session/fork')
            .map((frame) => frame.params)
        ).toEqual([{ sessionId: PROVIDER_SESSION, cwd: '/repo', mcpServers: [] }])
      )
      controller.abort(cancelled)
      expect(await outcome).toMatchObject({
        message: 'OMP could not copy this chat.',
        cause: cancelled
      })
      expect(children.map((child) => child.closes)).toEqual([1])
    } finally {
      controller.abort(cancelled)
      await copying.catch(() => {})
    }
  })

  it.each(['opencode', 'opencode2'] as const)(
    'refuses to copy a %s chat whose arguments route to a server, before starting OpenCode',
    async (agent) => {
      const spec = acpLaunchSpecFor(agent)!
      const connect = vi.fn()
      for (const [prefixArgs, args, launchReads] of [
        [[], ['--server', 'https://other-host:4096'], 0],
        [['run', '--', 'opencode'], ['--server', 'https://other-host:4096'], 0],
        [['run', '--', 'opencode', '--server=https://prefix-host:4096'], [], 1]
      ] as const) {
        const readLaunch = vi.fn(async () => {
          if (launchReads === 0) {
            throw new Error('launch preparation failed')
          }
          return {
            spec,
            command: 'launcher',
            prefixArgs: [...prefixArgs],
            args: [],
            cwd: '/workspace',
            env: {},
            envToDelete: [],
            fullAccess: true,
            resume: null
          }
        })
        await expect(
          copyAcpConversation(
            {
              spec,
              dataDirectory: '/orca-data',
              resolveLaunchArgs: () => [...args],
              readLaunch,
              connect
            },
            {
              ...input,
              identity: { ...input.identity, agent },
              accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } }
            },
            { track: () => {} }
          )
        ).rejects.toBeInstanceOf(OpenCodeCopyServerRouteError)
        expect(readLaunch).toHaveBeenCalledTimes(launchReads)
        expect(connect).not.toHaveBeenCalled()
      }
    }
  )
})
