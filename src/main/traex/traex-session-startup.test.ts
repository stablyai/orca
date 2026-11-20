import { afterEach, expect, it } from 'vitest'
import { TraexSessionAdapter, type TraexSessionAdapterDeps } from './traex-session-adapter'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { AgentSessionStartFailure } from '../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'

type ResolvedLaunch = Awaited<ReturnType<TraexSessionAdapterDeps['resolveLaunch']>>

const adapters: TraexSessionAdapter[] = []
const identity = {
  sessionId: 'trae-startup',
  workspaceId: 'folder-startup',
  hostId: 'local',
  agent: 'trae' as const,
  providerHandle: null
}
const launch: ResolvedLaunch = {
  command: process.execPath,
  args: ['-e', 'process.stdin.resume()'],
  cwd: process.cwd(),
  previousThreadId: null,
  mayBeUnsaved: false,
  options: {},
  permissionMode: 'ask',
  env: {},
  envToDelete: []
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.closeAll()))
})

it('refuses an acquisition whose launch resolves after shutdown', async () => {
  const entered = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<ResolvedLaunch>()
  const adapter = new TraexSessionAdapter({
    resolveLaunch: () => {
      entered.resolve()
      return pending.promise
    },
    readProcessStartTime: async () => 1,
    onLifecycle: () => {},
    onSettled: () => {}
  })
  adapters.push(adapter)
  const acquiring = adapter.acquire({ identity, fence: 1, spawnToken: 'late-start' })
  await entered.promise
  await adapter.closeAll()
  pending.resolve(launch)
  await expect(acquiring).rejects.toBeInstanceOf(AgentSessionPreSpawnError)
})

it('exposes a startup failure before publishing the root exit and until its owner retires', async () => {
  const exited = Promise.withResolvers<AgentSessionStartFailure | undefined>()
  const adapter = new TraexSessionAdapter({
    resolveLaunch: async () => ({
      ...launch,
      args: [
        '-e',
        [
          "process.stdin.once('data', data => {",
          'const { id } = JSON.parse(String(data));',
          "process.stdout.write(JSON.stringify({ id, result: {} }) + '\\n', () => process.exit(3));",
          '});'
        ].join('\n')
      ]
    }),
    readProcessStartTime: async () => 1,
    onLifecycle: () => {},
    onSettled: () => {}
  })
  adapters.push(adapter)
  let generation = ''
  const { logger } = recordingStructuredAgentSessionLogger()
  const sink = createDeferredStructuredAgentSessionEventSink({
    sessionId: identity.sessionId,
    logger
  })
  const acquired = await adapter.acquire({
    identity,
    fence: 1,
    spawnToken: 'failed-start',
    events: {
      ...sink.sink,
      observeRootExit: () => exited.resolve(adapter.startupEnding(identity.sessionId, generation))
    }
  })
  generation = acquired.acquisitionGeneration
  await expect(
    adapter.open({
      sessionId: identity.sessionId,
      fence: 1,
      acquisitionGeneration: generation,
      signal: new AbortController().signal
    })
  ).rejects.toBeInstanceOf(AgentSessionStartFailure)
  expect(await exited.promise).toBeInstanceOf(AgentSessionStartFailure)
  await adapter.drainObservedExits()
  adapter.acknowledgeSessionRelease(identity.sessionId)
  expect(adapter.startupEnding(identity.sessionId, generation)).toBeInstanceOf(
    AgentSessionStartFailure
  )
  adapter.retireStartup(identity.sessionId, generation)
  expect(adapter.startupEnding(identity.sessionId, generation)).toBeUndefined()
})
