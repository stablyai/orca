import { describe, expect, it } from 'vitest'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type { openClaudeStreamJsonConnection } from './claude-stream-json-connection'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  claudeStartupSettled,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  recordingJournalSink,
  USER_MESSAGE
} from './claude-structured-session-test-support'

function fixture(
  listing: 'empty' | 'error',
  openConnection?: typeof openClaudeStreamJsonConnection
) {
  const claude = fakeClaude({
    initModels: [],
    settings: {},
    routes: {
      list_models: () => {
        if (listing === 'error') {
          throw new Error('temporarily unavailable')
        }
        return []
      }
    }
  })
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/folder',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    onEvent: (event) => events.push(event),
    openConnection: openConnection ?? claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    persistHandle: async () => {}
  })
  return { claude, events, adapter }
}

describe('Claude chats with unavailable model discovery', () => {
  it.each(['empty', 'error'] as const)(
    'starts on the provider default and keeps choices usable when discovery is %s',
    async (listing) => {
      const { claude, events, adapter } = fixture(listing)
      try {
        await adapter.acquire({
          identity: identityFor(),
          fence: 7,
          spawnToken: 'spawn-9',
          events: recordingJournalSink()
        })
        await claudeStartupSettled(adapter, 'session-1')
        expect(events.some((event) => event.type === 'started')).toBe(true)
        expect(claude.connections[0].launch.options.model).toBeUndefined()
        const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
        // The built-in list stands in; an empty listing is no catalog for the host to save.
        expect(options.models.length).toBeGreaterThan(0)
        expect(options.catalogListing).toBeUndefined()
        // Nothing listed cannot refuse a choice while live discovery is unavailable.
        await expect(
          adapter.setOption({ sessionId: 'session-1', key: 'fastMode', value: 'true', fence: 7 })
        ).resolves.toMatchObject({ fastMode: 'true' })
        await expect(
          adapter.dispatch({
            sessionId: 'session-1',
            clientMessageId: 'client-1',
            body: USER_MESSAGE,
            fence: 7
          })
        ).resolves.toEqual({ state: 'admitted' })
        expect(claude.connections[0].sent).toContainEqual(expect.objectContaining({ type: 'user' }))
        expect(events.some((event) => event.type === 'ended')).toBe(false)
      } finally {
        await adapter.closeAll()
      }
    }
  )

  it.each(['empty', 'failed-start'] as const)(
    'lists afresh in a new child after %s',
    async (firstResult) => {
      let available = false
      const children: ReturnType<typeof fakeClaude>[] = []
      const openConnection: typeof openClaudeStreamJsonConnection = async (launch, handlers) => {
        const models = available ? [{ value: 'recovered', displayName: 'Recovered' }] : []
        const child = fakeClaude({
          initModels: models,
          settings: {},
          ...(!available && firstResult === 'failed-start'
            ? { exitBeforeInit: 'initialize rejected' }
            : {})
        })
        children.push(child)
        const connection = await child.openConnection(launch, handlers)
        // Like the SDK, each connection reads only its own initialize snapshot.
        connection.supportedModels = async () => models
        return connection
      }
      const { adapter } = fixture('empty', openConnection)
      try {
        const acquire = adapter.acquire({
          identity: identityFor(),
          fence: 7,
          spawnToken: 'spawn-9'
        })
        if (firstResult === 'failed-start') {
          await expect(acquire).rejects.toThrow('initialize rejected')
        } else {
          await acquire
          await claudeStartupSettled(adapter, 'session-1')
        }
        available = true
        if (firstResult === 'empty') {
          const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
          expect(options.models.some((model) => model.id === 'recovered')).toBe(false)
        } else {
          await adapter.drainObservedExits()
          expect(children[0].connections[0].closed).toBe(true)
        }
        await adapter.closeSession('session-1')
        await adapter.acquire({ identity: identityFor(), fence: 8, spawnToken: 'spawn-10' })
        await claudeStartupSettled(adapter, 'session-1')
        const options = await adapter.readOptions({ sessionId: 'session-1', fence: 8 })
        expect(options.models).toContainEqual({
          id: 'recovered',
          label: 'Recovered',
          isDefault: false,
          efforts: []
        })
        expect(options.catalogListing?.models.map((model) => model.id)).toEqual(['recovered'])
        expect(children).toHaveLength(2)
        expect(children[1].connections[0].launch.options.model).toBeUndefined()
      } finally {
        await adapter.closeAll()
      }
    }
  )
})
