import { afterEach, expect, it, onTestFinished } from 'vitest'
import recorded from './fixtures/opencode-v2.0.21-model-efforts.json'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { framesOf, launch, openHostRig, send } from './acp-structured-host.test-support'
import {
  NewSessionResponseSchema,
  SetSessionConfigOptionRequestSchema,
  SetSessionConfigOptionResponseSchema
} from './generated/acp-protocol.generated'
import { PROVIDER_SESSION, waitFor } from './acp-structured-adapter.test-support'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { AgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store'
import { AcpStructuredOptions } from './acp-structured-options'

afterEach(closeProviderTimelineRigs)

it.each(['idle', 'busy', 'resting'] as const)(
  'offers the selected OpenCode model effort menu before Send while %s',
  async (phase) => {
    const spec = acpLaunchSpecFor('opencode2')!
    const initial = 'opencode/crouton-alpha-free'
    const target = 'opencode/beam-free'
    const opened = NewSessionResponseSchema.parse({ ...recorded.new, sessionId: PROVIDER_SESSION })
    const changed = SetSessionConfigOptionResponseSchema.parse(recorded[target])
    const models = [opened, changed].map((response) => {
      const options = new AcpStructuredOptions(spec.dialect)
      options.adoptSession(response)
      const answer = options.read()
      return answer.models.find((model) => model.id === answer.current.model)!
    })
    let records: AgentSessionRecordStore | undefined
    const accountHome = { kind: 'opencode' as const, locator: { kind: 'unmanaged' as const } }
    const catalog = createAgentModelCatalogService({
      store: new AgentModelCatalogStore(),
      getRecord: (id) => records?.getRecord(id) ?? undefined,
      getConversation: (id) => records?.getConversation(id) ?? undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => accountHome,
      recordWorkspacePath: async () => '/workspace',
      agentReadsProjectModelConfig: () => false,
      workspaceMayOverrideDefaultModel: async () => false,
      probes: { opencode2: async () => ({ models, origin: 'probe' }) }
    })
    onTestFinished(() => catalog.stop())
    let native = opened.configOptions ?? []
    const rig = await openHostRig({
      spec,
      modelCatalog: catalog,
      deps: { resolveLaunch: launch(() => false, spec) },
      script: (agent) => {
        for (const method of ['session/new', 'session/load', 'session/resume']) {
          agent.on(method, (frame) => agent.reply(frame, { ...opened, configOptions: native }))
        }
        agent.on('session/set_config_option', (frame) => {
          const { configId, value } = SetSessionConfigOptionRequestSchema.parse(frame.params)
          if (configId === 'model') {
            native = value === target ? changed.configOptions : (opened.configOptions ?? [])
          } else {
            native = native.map((row) =>
              row.type === 'select' && row.id === configId
                ? { ...row, currentValue: String(value) }
                : row
            )
          }
          agent.reply(frame, { configOptions: native })
        })
      }
    })
    records = rig.store
    expect(
      await rig.host.attach(
        CALLER,
        hostTestAttachParams(null, {
          provider: 'opencode2',
          agent: 'opencode2',
          accountHome,
          providerHandle: undefined,
          options: { model: initial, effort: 'high' }
        })
      )
    ).toMatchObject({ ok: true })
    await rig.ready()
    const inventory = await catalog.read({
      agent: 'opencode2',
      sessionId: SESSION,
      waitForListing: true
    })
    expect(inventory.origin).not.toBe('unknown')
    expect(
      inventory.origin === 'unknown'
        ? []
        : inventory.models.find((row) => row.id === target)?.efforts.map((row) => row.value)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'default'])
    try {
      if (phase === 'resting') {
        await rig.host.close(SESSION, 'user-close')
      }
      if (phase === 'busy') {
        await send(rig.host, 'existing turn')
        await waitFor(() => expect(framesOf(rig.rig.child(), 'session/prompt')).toHaveLength(1))
      }
      const fields = { key: 'model', value: target }
      expect(
        await rig.host.setOption(CALLER, {
          envelope: envelope('agentSession.setOption', fields),
          ...fields
        })
      ).toMatchObject({ ok: true })
      const answer = await rig.host.readOptions(SESSION)
      expect(answer.current).toMatchObject({ model: target, effort: 'high' })
      expect(
        framesOf(rig.rig.child(), 'session/set_config_option').some((frame) => {
          const request = SetSessionConfigOptionRequestSchema.parse(frame.params)
          return request.configId === 'model' && request.value === target
        })
      ).toBe(phase === 'idle')
      expect(
        answer.models.find((row) => row.id === target)?.efforts.map((row) => row.value)
      ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'default'])
    } finally {
      if (phase === 'busy') {
        const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
        const prompt = framesOf(rig.rig.child(), 'session/prompt').at(-1)!
        rig.rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
        await waitFor(() => expect(journal.runningTurn()).toBeNull())
        await rig.rig.settle()
        await rig.host.flushStreamedEvents(SESSION)
      }
      await rig.host.close(SESSION, 'user-close')
    }
  }
)
