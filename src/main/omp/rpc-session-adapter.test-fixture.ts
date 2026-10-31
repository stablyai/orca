import { vi } from 'vitest'
import { OmpRpcSessionAdapter } from './rpc-session-adapter'
import { FakeConnection } from '../pi/rpc-session-adapter.test-fixture'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'

const adapters: OmpRpcSessionAdapter[] = []
type AdapterDeps = ConstructorParameters<typeof OmpRpcSessionAdapter>[0]
export async function closeOmpRpcAdapterFixtures(): Promise<void> {
  for (const adapter of adapters.splice(0)) {
    await adapter.closeAll()
    await adapter.drainObservedExits()
    adapter.acknowledgeSessionRelease('omp-test')
  }
  await closeProviderTimelineRigs()
}

export async function setupOmpRpcAdapter(
  childReporting: 'attempt' | 'registration' = 'attempt',
  configure?: (connection: FakeConnection) => void
) {
  const rig = await openProviderTimelineRig({ agent: 'omp', sessionId: 'omp-test' })
  let connection: FakeConnection | undefined
  const childWork =
    vi.fn<NonNullable<Parameters<OmpRpcSessionAdapter['acquire']>[0]['childWork']>>()
  const settled = vi.fn<AdapterDeps['onSettled']>()
  const logger = {
    warn: vi.fn<AdapterDeps['logger']['warn']>(),
    error: vi.fn<AdapterDeps['logger']['error']>()
  }
  const adapter = new OmpRpcSessionAdapter({
    resolveLaunch: async () => ({
      command: 'omp',
      cwd: '/workspace',
      fullAccess: true,
      previous: null
    }),
    readProcessStartTime: async () => 12345,
    openConnection: (_launch, handlers) => {
      connection = new FakeConnection(handlers)
      configure?.(connection)
      return connection
    },
    onLifecycle: vi.fn(),
    onSettled: settled,
    onChildWorkEvidence: (_sessionId, evidence) => childWork(evidence),
    logger
  })
  adapters.push(adapter)
  const acquired = await adapter.acquire({
    identity: {
      sessionId: 'omp-test',
      agent: 'omp',
      hostId: 'local',
      workspaceId: 'folder',
      providerHandle: null
    },
    fence: 1,
    spawnToken: 'spawn',
    events: rig.eventSink,
    ...(childReporting === 'attempt' ? { childWork } : {})
  })
  const opened = await adapter.open({
    sessionId: 'omp-test',
    fence: 1,
    acquisitionGeneration: acquired.acquisitionGeneration,
    signal: new AbortController().signal
  })
  if (!connection) {
    throw new Error('No child')
  }
  return { adapter, rig, connection, opened, childWork, settled, logger }
}
