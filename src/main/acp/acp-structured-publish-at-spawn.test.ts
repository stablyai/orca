import { acpLaunchSpecFor } from './acp-launch-specs'
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
  it('publishes mapped initial/config permission without selecting it, and generic unknown for legacy modes', async () => {
    const mode = {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'yolo', name: 'Yolo' }
      ]
    }
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('antigravity')!,
      script: (agent) =>
        agent.on('session/new', (frame) =>
          agent.reply(frame, {
            sessionId: PROVIDER_SESSION,
            configOptions: [...GROK_CONFIG_OPTIONS, mode]
          })
        )
    })
    await rig.acquire({ permissionMode: 'own' })
    expect(rig.started().reportedOptions).toMatchObject({ reportedPermissionMode: 'ask' })
    for (const [currentValue, expected] of [
      ['yolo', 'full-access'],
      ['unknown', null]
    ] as const) {
      rig.child().agent.notify('session/update', {
        sessionId: PROVIDER_SESSION,
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: [...GROK_CONFIG_OPTIONS, { ...mode, currentValue }]
        }
      })
      await waitFor(() =>
        expect(rig.lifecycle.at(-1)).toMatchObject({
          type: 'options-reported',
          reportedOptions: { reportedPermissionMode: expected }
        })
      )
    }
    expect(rig.sent('session/set_config_option')).toHaveLength(0)
  })

  it('opens without writing saved message choices to the provider', async () => {
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
      options: { effort: 'low', model: 'grok-4.6' }
    })
    expect(acquired.process.pid).toBe(4242)
    if (!acquired.acquisitionGeneration) {
      throw new Error('missing acquisition generation')
    }
    expect(acquired.link).toBeUndefined()
    expect(rig.adapter.holdsLiveProviderProcess(SESSION, acquired.acquisitionGeneration)).toBe(true)
    expect(rig.adapter.holdsDispatch(SESSION)).toBe(false)
    expect(rig.adapter.readCommands(SESSION)).toBeUndefined()
    const opening = rig.adapter.open({
      sessionId: SESSION,
      fence: 1,
      acquisitionGeneration: acquired.acquisitionGeneration,
      signal: new AbortController().signal
    })
    await rig.frame('session/new')
    expect(rig.lifecycle).toEqual([])
    answer?.()
    expect(await opening).toMatchObject({
      link: { handle: { nativeId: PROVIDER_SESSION }, origin: 'created' },
      reportedOptions: { model: 'grok-4.7', effort: 'high' }
    })
    expect(writes).toEqual([])
    rig.child().agent.notify('session/update', {
      sessionId: PROVIDER_SESSION,
      update: { sessionUpdate: 'config_option_update', configOptions: GROK_CONFIG_OPTIONS }
    })
    await waitFor(() =>
      expect(rig.lifecycle.map((event) => event.type)).toEqual(['options-reported'])
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
      const opening = rig.adapter
        .open({
          sessionId: SESSION,
          fence: 1,
          acquisitionGeneration: acquired.acquisitionGeneration,
          signal: new AbortController().signal
        })
        .catch((error: unknown) => error)
      await rig.frame('session/new')
      if (!acquired.acquisitionGeneration) {
        throw new Error('missing acquisition generation')
      }
      const closed =
        method === 'releaseAcquisition'
          ? rig.adapter[method]({ sessionId: SESSION })
          : rig.adapter[method](SESSION)
      expect(await closed).toBe(true)
      expect(await opening).toBeInstanceOf(Error)
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
      const opening = rig.adapter
        .open({
          sessionId: SESSION,
          fence: 1,
          acquisitionGeneration: 'gen-acp',
          signal: new AbortController().signal
        })
        .catch((error: unknown) => error)
      await rig.frame(answered ? 'session/new' : 'initialize')
      rig.child().stderr = 'provider config is invalid'
      rig.child().exit()
      expect(await opening).toBeInstanceOf(Error)
      expect(rig.ended).toMatchObject([
        { failure: { detail: { text: 'provider config is invalid' } } }
      ])
      expect(rig.ended[0]?.startupUnanswered).toBeUndefined()
    }
  )

  it('reports signed-out startup as a notSignedIn fact and proves the process ended', async () => {
    const rig = await openAcpAdapterRig({
      script: (agent) =>
        agent.on('session/new', (frame) => agent.fail(frame, -32000, 'Authentication required'))
    })
    const acquired = await rig.acquire({ waitForStart: false })
    await expect(
      rig.adapter.open({
        sessionId: SESSION,
        fence: 1,
        acquisitionGeneration: acquired.acquisitionGeneration,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ reason: 'notSignedIn' })
    expect(rig.ended).toEqual([])
    await rig.adapter.closeSession(SESSION)
    expect(rig.child().exited).toBe(true)
  })

  it('waits until message input to try a saved choice the provider will refuse', async () => {
    const rig = await openAcpAdapterRig({
      script: (agent) =>
        agent.on('session/set_config_option', (frame) =>
          agent.fail(frame, -32602, 'model unavailable')
        )
    })
    await rig.acquire({ options: { model: 'retired-model' } })
    expect(rig.started()).toMatchObject({
      reportedOptions: { model: 'grok-4.7', effort: 'high' }
    })
    expect(rig.sent('session/set_config_option')).toEqual([])
    await expect(
      rig.adapter.dispatch({
        sessionId: SESSION,
        fence: 1,
        clientMessageId: 'refused-choice',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
        executionOptions: { model: 'retired-model' }
      })
    ).rejects.toMatchObject({ name: 'AgentSessionOptionRejectedError' })
    expect(rig.sent('session/set_config_option')).toHaveLength(1)
    expect(rig.sent('session/prompt')).toEqual([])
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
