import { describe, expect, it } from 'vitest'
import {
  AgentModelCatalogStore,
  type AgentModelCatalogLiveListing
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { retireClaudeLaunchedModel } from './claude-structured-retired-model'
import {
  adapterFor,
  claudeFrame,
  claudeStartupSettled,
  fakeClaude,
  tick,
  identityFor,
  PROVIDER_SESSION_ID,
  recordingJournalSink
} from './claude-structured-session-test-support'

const RETIRED = 'claude-retired-1'
/** The rows Claude Code 2.1.280 lists for a child launched with `--model claude-bogus-9`: its own
 *  native rows, then one for the launched id, named by that id. */
const NATIVE_OPUS = { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus' }
const LAUNCHED_ROW = {
  value: RETIRED,
  resolvedModel: RETIRED,
  displayName: RETIRED,
  description: 'Custom model'
}

function modelNotFound(parentToolUseId: string | null = null): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: 'reply-1',
    session_id: PROVIDER_SESSION_ID,
    parent_tool_use_id: parentToolUseId,
    error: 'model_not_found',
    is_api_error_message: true,
    message: { model: '<synthetic>', role: 'assistant', content: [] }
  }
}

function sessionLaunchedWith(model: string | null, picked: string | null = model) {
  return {
    launchedModel: model,
    options: new Map(picked === null ? [] : [['model', picked]]),
    restoreSkippedOptions: new Set<string>()
  }
}

describe("the CLI's word that a launched model does not exist", () => {
  it('drops the launched model once, as a skipped saved option', () => {
    const session = sessionLaunchedWith(RETIRED)

    expect(retireClaudeLaunchedModel(session, modelNotFound())).toBe(RETIRED)
    expect(session.options.has('model')).toBe(false)
    expect([...session.restoreSkippedOptions]).toEqual(['model'])
    expect(retireClaudeLaunchedModel(session, modelNotFound())).toBeNull()
  })

  it.each([
    ['a subagent reply', sessionLaunchedWith(RETIRED), modelNotFound('toolu_1')],
    ['another error', sessionLaunchedWith(RETIRED), { ...modelNotFound(), error: 'rate_limit' }],
    ['a model picked since the launch', sessionLaunchedWith(RETIRED, 'opus'), modelNotFound()],
    ['a launch that named no model', sessionLaunchedWith(null), modelNotFound()]
  ])('keeps the saved model for %s', (_case, session, message) => {
    expect(retireClaudeLaunchedModel(session, message)).toBeNull()
    expect([...session.restoreSkippedOptions]).toEqual([])
  })
})

describe("the account catalog facts a child's listing hands the host", () => {
  async function listingOfChildLaunchedWith(model: string) {
    const claude = fakeClaude({
      initModels: [NATIVE_OPUS, LAUNCHED_ROW],
      routes: { list_models: () => [NATIVE_OPUS, LAUNCHED_ROW] }
    })
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: recordingJournalSink(),
      options: { model }
    })
    await claudeStartupSettled(adapter, 'session-1')
    const { catalogListing } = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    await adapter.closeAll()
    return catalogListing
  }

  function savedIds(cached: string[] | null, listing: AgentModelCatalogLiveListing) {
    const store = new AgentModelCatalogStore()
    if (cached) {
      store.recordSuccess(
        'fp',
        'claude',
        {
          models: cached.map((id) => ({ id, label: id, isDefault: false, efforts: [] })),
          origin: 'probe'
        },
        'discovery'
      )
    }
    store.recordSuccess('fp', 'claude', { ...listing, origin: 'live-session' }, 'live')
    return store.get('fp')?.models.map((model) => model.id)
  }

  it('marks the row the launch added for its own model, which the account catalog leaves out', async () => {
    const listing = await listingOfChildLaunchedWith(RETIRED)
    expect(listing?.launchOnlyModelId).toBe(RETIRED)
    expect(savedIds(null, listing!)).toEqual(['opus'])
  })

  it('keeps that row when the account already listed the model', async () => {
    const listing = await listingOfChildLaunchedWith(RETIRED)
    expect(savedIds([RETIRED], listing!)).toEqual(['opus', RETIRED])
  })

  it('marks nothing for a launched native model, which carries its own display name', async () => {
    const listing = await listingOfChildLaunchedWith('opus')
    expect(listing?.launchOnlyModelId).toBeUndefined()
    expect(savedIds(null, listing!)).toEqual(['opus', RETIRED])
  })
})

describe('a live child still launched with a retired model', () => {
  async function healed(holdReset: boolean) {
    let answerReset: () => void = () => {}
    const claude = fakeClaude({
      initModels: [NATIVE_OPUS, LAUNCHED_ROW],
      routes: {
        list_models: () => [NATIVE_OPUS],
        set_model: (params) =>
          holdReset && params?.model === undefined
            ? new Promise<void>((resolve) => (answerReset = resolve))
            : undefined
      }
    })
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: RETIRED }
    })
    claudeFrame(claude.connections[0]!, modelNotFound())
    return { claude, adapter, answerReset: () => answerReset() }
  }

  function setModelCalls(claude: ReturnType<typeof fakeClaude>) {
    return claude.connections[0]!.calls.filter((call) => call.subtype === 'set_model')
  }

  it("goes back to the CLI's own default, so the next turn runs", async () => {
    const { claude, adapter } = await healed(false)
    await tick()

    expect(setModelCalls(claude)).toEqual([{ subtype: 'set_model', params: { model: undefined } }])
    const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(options.current.model).not.toBe(RETIRED)
    await adapter.closeAll()
  })

  it('keeps a model the user picks before the reset lands', async () => {
    const { claude, adapter, answerReset } = await healed(true)
    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'opus', fence: 7 })
    answerReset()
    await tick()

    // The pick goes out after the reset, so the CLI runs it; the reset's bookkeeping stands aside.
    expect(setModelCalls(claude).map((call) => call.params?.model)).toEqual([undefined, 'opus'])
    const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(options.current.model).toBe('opus')
    await adapter.closeAll()
  })
})
