import { describe, expect, it } from 'vitest'
import { retireClaudeLaunchedModel } from './claude-structured-retired-model'
import {
  adapterFor,
  claudeFrame,
  claudeStartupSettled,
  fakeClaude,
  tick,
  identityFor,
  PROVIDER_SESSION_ID,
  recordingJournalSink,
  USER_MESSAGE
} from './claude-structured-session-test-support'

const RETIRED = 'claude-retired-1'
/** Claude Code 2.1.280 lists native rows plus the custom model passed at launch. */
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
    options: new Map(picked === null ? [] : [['model', picked]])
  }
}

describe("the CLI's word that a launched model does not exist", () => {
  it('drops the launched model once, as a skipped saved option', () => {
    const session = sessionLaunchedWith(RETIRED)

    expect(retireClaudeLaunchedModel(session, modelNotFound())).toBe(RETIRED)
    expect(session.options.has('model')).toBe(false)
    expect(retireClaudeLaunchedModel(session, modelNotFound())).toBeNull()
  })

  it.each([
    ['a subagent reply', sessionLaunchedWith(RETIRED), modelNotFound('toolu_1')],
    ['another error', sessionLaunchedWith(RETIRED), { ...modelNotFound(), error: 'rate_limit' }],
    ['a model picked since the launch', sessionLaunchedWith(RETIRED, 'opus'), modelNotFound()],
    ['a launch that named no model', sessionLaunchedWith(null), modelNotFound()]
  ])('keeps the saved model for %s', (_case, session, message) => {
    expect(retireClaudeLaunchedModel(session, message)).toBeNull()
  })
})

describe("a child's listing ownership", () => {
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

  it('keeps a child listing local to its session', async () => {
    expect(await listingOfChildLaunchedWith(RETIRED)).toBeUndefined()
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
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'saved-choice',
        body: USER_MESSAGE,
        executionOptions: { model: RETIRED },
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'admitted' })
    expect(setModelCalls(claude).map((call) => call.params?.model)).toEqual([undefined, RETIRED])
    await adapter.closeAll()
  })

  it('keeps a model the user picks before the reset lands', async () => {
    const { claude, adapter, answerReset } = await healed(true)
    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'opus', fence: 7 })
    answerReset()
    await tick()

    expect(setModelCalls(claude).map((call) => call.params?.model)).toEqual([undefined, 'opus'])
    const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(options.current.model).toBe('opus')
    await adapter.closeAll()
  })
})
