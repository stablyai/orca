import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  GROK_CONFIG_OPTIONS,
  openAcpAdapterRig,
  PROVIDER_SESSION,
  waitFor
} from './acp-structured-adapter.test-support'
import type { FakeFrame } from './acp-scripted-agent.test-support'

afterEach(closeProviderTimelineRigs)
const configParams = z.object({ configId: z.string(), value: z.string() })

describe('ACP child published before its handshake', () => {
  it('returns at spawn, then reports its real session and restored picks in model-before-effort order', async () => {
    let answer: (() => void) | undefined
    const writes: string[] = []
    let configOptions = GROK_CONFIG_OPTIONS
    const rig = await openAcpAdapterRig({
      script: (agent) => {
        agent.on('session/new', (frame) => {
          answer = () => agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions })
        })
        agent.on('session/set_config_option', (frame) => {
          const { configId: key, value } = configParams.parse(frame.params)
          writes.push(key)
          configOptions = configOptions.map((option) =>
            option.id === key ? { ...option, currentValue: value } : option
          )
          agent.reply(frame, { configOptions })
        })
      }
    })
    const acquired = await rig.acquire({
      waitForStart: false,
      options: { effort: 'low', model: 'grok-4.6' },
      optionRevision: () => 7
    })
    expect(acquired.process.pid).toBe(4242)
    if (!acquired.acquisitionGeneration) {
      throw new Error('missing acquisition generation')
    }
    expect(acquired.link).toBeUndefined()
    expect(rig.adapter.holdsLiveProviderProcess(SESSION, acquired.acquisitionGeneration)).toBe(true)
    expect(rig.adapter.holdsDispatch(SESSION)).toBe(false)
    expect(rig.adapter.readCommands(SESSION)).toBeUndefined()
    await rig.frame('session/new')
    expect(rig.lifecycle).toEqual([])
    answer?.()
    await waitFor(() =>
      expect(rig.started()).toMatchObject({
        link: { handle: { nativeId: PROVIDER_SESSION }, origin: 'created' },
        reportedOptions: { model: 'grok-4.6', effort: 'low' },
        restoreSkippedOptions: [],
        optionRevision: 7
      })
    )
    expect(writes).toEqual(['model', 'reasoning_effort'])
    rig.child().agent.notify('session/update', {
      sessionId: PROVIDER_SESSION,
      update: { sessionUpdate: 'config_option_update', configOptions: GROK_CONFIG_OPTIONS }
    })
    await waitFor(() =>
      expect(rig.lifecycle.map((event) => event.type)).toEqual(['started', 'options-reported'])
    )
  })

  it.each(['closeSession', 'disposeSession', 'forceCloseSession', 'releaseAcquisition'] as const)(
    'lets %s stop the starting process without a late start',
    async (method) => {
      let frame: FakeFrame | undefined
      const rig = await openAcpAdapterRig({
        script: (agent) =>
          agent.on('session/new', (request) => {
            frame = request
          })
      })
      const acquired = await rig.acquire({ waitForStart: false })
      await rig.frame('session/new')
      if (!acquired.acquisitionGeneration) {
        throw new Error('missing acquisition generation')
      }
      const closed =
        method === 'releaseAcquisition'
          ? rig.adapter[method]({ sessionId: SESSION })
          : rig.adapter[method](SESSION)
      expect(await closed).toBe(true)
      if (frame) {
        rig.child().agent.reply(frame, { sessionId: PROVIDER_SESSION })
      }
      await rig.settle()
      expect(rig.lifecycle.map((event) => event.type)).toEqual(['ended'])
      expect(rig.adapter.holdsLiveProviderProcess(SESSION, acquired.acquisitionGeneration)).toBe(
        false
      )
    }
  )

  it.each([true, false])(
    'reports a startup exit with initialize answered = %s',
    async (answered) => {
      const rig = await openAcpAdapterRig({
        script: (agent) => agent.on(answered ? 'session/new' : 'initialize', () => {})
      })
      await rig.acquire({ waitForStart: false })
      await rig.frame(answered ? 'session/new' : 'initialize')
      rig.child().stderr = 'provider config is invalid'
      rig.child().exit()
      expect(rig.ended).toMatchObject([
        { startupUnproven: true, failure: { detail: { text: 'provider config is invalid' } } }
      ])
      expect(rig.ended[0]?.startupUnanswered).toBe(answered ? undefined : true)
    }
  )

  it('reports signed-out startup as a notSignedIn fact and proves the process ended', async () => {
    const rig = await openAcpAdapterRig({
      script: (agent) =>
        agent.on('session/new', (frame) => agent.fail(frame, -32000, 'Authentication required'))
    })
    await rig.acquire()
    expect(rig.ended).toMatchObject([
      {
        startupUnproven: true,
        cause: 'unexpected-exit',
        failure: { kind: 'notSignedIn', detail: { text: 'Authentication required' } }
      }
    ])
    expect(rig.child().exited).toBe(true)
  })

  it('reports saved picks the provider refused without delaying readiness for another read', async () => {
    const rig = await openAcpAdapterRig({
      script: (agent) =>
        agent.on('session/set_config_option', (frame) =>
          agent.fail(frame, -32602, 'model unavailable')
        )
    })
    await rig.acquire({ options: { model: 'retired-model' } })
    expect(rig.started()).toMatchObject({
      restoreSkippedOptions: ['model'],
      reportedOptions: { model: 'grok-4.7', effort: 'high' }
    })
    expect(rig.child().exited).toBe(false)
  })

  it('reports the session it loaded as the resumed link', async () => {
    const rig = await openAcpAdapterRig({
      launch: {
        resume: {
          sessionId: 'saved-session',
          key: 'saved-key',
          mayBeUnsaved: () => false,
          unannouncedLosses: () => []
        }
      }
    })
    const acquired = await rig.acquire()
    expect(acquired.link).toBeUndefined()
    expect(rig.started().link).toMatchObject({
      handle: { nativeId: 'saved-session' },
      origin: 'resumed'
    })
    expect(rig.sent('session/new')).toEqual([])
  })
})
