import { afterEach, expect, it, vi } from 'vitest'
import { FakeConnection, state } from '../pi/rpc-session-adapter.test-fixture'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { OmpRpcSessionAdapter } from './rpc-session-adapter'

const adapters: OmpRpcSessionAdapter[] = []
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.closeAll()))
  await closeProviderTimelineRigs()
})

it.each(['resume', 'fork', 'fresh'])(
  'starts the %s with the user-selected provider before RPC model restoration',
  async (kind) => {
    const rig = await openProviderTimelineRig({ agent: 'omp', sessionId: 'recovery' })
    const adapter = new OmpRpcSessionAdapter({
      resolveLaunch: async () => ({
        command: 'omp',
        cwd: '/workspace',
        fullAccess: true,
        previous: null,
        ...(kind === 'resume' ? { sessionFile: state.sessionFile } : {}),
        ...(kind === 'fork' ? { forkFile: state.sessionFile } : {}),
        extraArgs: ['--provider', 'openai-codex', '--model', 'gpt-6.1-sol', '-e', 'extension.ts']
      }),
      openConnection: (launch, handlers) => {
        const connection = new FakeConnection(handlers)
        const provider = launch.args[launch.args.lastIndexOf('--provider') + 1]
        const model = launch.args[launch.args.lastIndexOf('--model') + 1]
        connection.requestOverride = (command) => {
          if (provider !== 'replacement' || model !== 'org/model') {
            return Promise.reject(
              new Error(
                'SessionModelRestoreError: Could not restore model openai-codex/gpt-6.1-sol'
              )
            )
          }
          return command === 'get_state'
            ? Promise.resolve({
                ...state,
                ...(kind === 'fork' ? { sessionFile: '/host/account/sessions/fork.jsonl' } : {}),
                model: { provider, id: model }
              })
            : undefined
        }
        expect(launch.args).toContain('extension.ts')
        return connection
      },
      readProcessStartTime: async () => 1,
      onLifecycle: vi.fn(),
      onSettled: vi.fn(),
      logger: { warn: vi.fn(), error: vi.fn() }
    })
    adapters.push(adapter)
    const acquired = await adapter.acquire({
      identity: {
        sessionId: 'recovery',
        agent: 'omp',
        hostId: 'local',
        workspaceId: 'folder',
        providerHandle: null
      },
      fence: 1,
      spawnToken: 'spawn',
      options: { model: 'replacement/org/model' },
      events: rig.eventSink
    })
    await expect(
      adapter.open({
        sessionId: 'recovery',
        fence: 1,
        acquisitionGeneration: acquired.acquisitionGeneration,
        signal: new AbortController().signal
      })
    ).resolves.toMatchObject({ reportedOptions: { model: 'replacement/org/model' } })
  }
)
