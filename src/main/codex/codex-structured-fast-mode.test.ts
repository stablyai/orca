import { describe, expect, it, vi } from 'vitest'
import {
  USER_MESSAGE,
  adapterFor,
  fakeCodex,
  identityFor,
  type Route
} from './codex-structured-session-adapter-fixture'

describe('Codex structured Fast mode dispatch', () => {
  it('uses the provider-advertised Fast tier on the first turn after acquisition', async () => {
    const codex = fakeCodex({
      'model/list': () => ({
        data: [
          {
            model: 'gpt-live',
            supportedReasoningEfforts: [],
            serviceTiers: [{ id: 'priority-live-v2', name: 'Fast' }]
          }
        ],
        nextCursor: null
      }),
      'turn/start': () => ({ turn: { id: 'turn-fast' } })
    })

    const adapter = adapterFor(codex)
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { fastMode: 'true' }
    })

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-fast',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ serviceTier: 'priority-live-v2' })
  })

  it('uses Standard on the first turn after acquisition with Fast explicitly off', async () => {
    const codex = fakeCodex({ 'turn/start': () => ({ turn: { id: 'turn-standard' } }) })
    const adapter = adapterFor(codex)
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { fastMode: 'false' }
    })

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-standard',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ serviceTier: 'default' })
    expect(codex.connections[0].calls.some((call) => call.method === 'model/list')).toBe(false)
  })

  it.each(['absent', 'transient'] as const)(
    'uses Standard while restored Fast discovery is %s, then recovers the exact tier',
    async (discovery) => {
      const unavailableCatalog = () => {
        if (discovery === 'transient') {
          throw new Error('catalog temporarily unavailable')
        }

        return {
          data: [{ model: 'gpt-live', supportedReasoningEfforts: [] }],
          nextCursor: null
        }
      }

      const listModels = vi.fn<Route>().mockImplementationOnce(unavailableCatalog)

      if (discovery === 'absent') {
        listModels.mockImplementationOnce(unavailableCatalog)
      }

      listModels.mockImplementation(() => ({
        data: [
          {
            model: 'gpt-live',
            supportedReasoningEfforts: [],
            serviceTiers: [{ id: 'priority-recovered', name: 'Fast' }]
          }
        ],
        nextCursor: null
      }))

      const codex = fakeCodex({
        'model/list': listModels,
        'turn/start': () => ({ turn: { id: 'turn-recovered' } })
      })

      const adapter = adapterFor(codex)
      await expect(
        adapter.acquire({
          identity: identityFor('session-1'),
          fence: 7,
          spawnToken: 'spawn-9',
          options: { fastMode: 'true' }
        })
      ).resolves.toBeDefined()

      await expect(
        adapter.dispatch({
          sessionId: 'session-1',
          clientMessageId: 'client-unverified',
          body: USER_MESSAGE,
          fence: 7
        })
        // `admitted`, not `accepted`: a Codex send now settles its identity on
        // the provider echo. What this test pins is the tier the turn carries.
      ).resolves.toMatchObject({ state: 'admitted' })
      expect(
        codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
      ).toMatchObject({ serviceTier: 'default' })

      let options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
      expect(options).toMatchObject({
        current: { fastMode: true }
      })

      if (discovery === 'absent') {
        expect(options.fastModeSupport).toBeUndefined()
        expect(options.models[0]?.supportsFastMode).toBeUndefined()
        options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
      }

      expect(options).toMatchObject({
        models: [expect.objectContaining({ supportsFastMode: true })],
        fastModeSupport: { supported: true },
        current: { fastMode: true }
      })
      await adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-recovered',
        body: USER_MESSAGE,
        fence: 7
      })
      expect(
        codex.connections[0].calls.filter((call) => call.method === 'turn/start')[1]?.params
      ).toMatchObject({ serviceTier: 'priority-recovered' })
    }
  )
})
