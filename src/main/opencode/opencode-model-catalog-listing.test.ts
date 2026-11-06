import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseOpenCodeModelListing } from './opencode-model-catalog-listing'
import { structuredAgentSessionSeedCatalog } from '../../shared/agent-session/options/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  commitStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState
} from '../../shared/agent-session/options/structured-agent-session-options'
import {
  structuredAgentSessionMessageSelection,
  structuredAgentSessionSendSelection
} from '../../shared/agent-session/options/structured-agent-session-option-view'
import { buildNativeChatSessionOptionSnapshot } from '../../shared/native-chat/input/native-chat-session-option-snapshot'
import { resolveAgentSessionOptionLaunch } from '../../shared/agent-session/options/agent-session-option-launch'

describe('OpenCode verbose model listing', () => {
  it('declares the variant a recorded 1.x listing runs, shown but never sent', () => {
    // OpenCode 1.18.31 models --verbose capture, 2026-10-30; one complete model row.
    const stdout = readFileSync(
      new URL('../acp/fixtures/opencode-v1-model-listing.txt', import.meta.url),
      'utf8'
    )
    const models = parseOpenCodeModelListing(stdout)
    const model = models[0]!
    expect(model?.efforts.map(({ value }) => value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'default'
    ])
    // OpenCode 1.x ACP runs the first listed variant when none is literally named default.
    expect(model).toMatchObject({ defaultEffort: 'low', declaredDefaultEffort: 'low' })

    const seed = structuredAgentSessionSeedCatalog('opencode')
    const listed = applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState('opencode', seed),
      seed,
      { origin: 'probe', models, fetchedAt: 1, listingNamesConfiguredModel: false },
      { newLaunch: true }
    )
    const pickedModel = commitStructuredAgentSessionOption(listed, 'model', model.id)
    const catalog = pickedModel.catalog!
    const draft = buildNativeChatSessionOptionSnapshot({
      catalog,
      models: catalog.models,
      record: {
        agent: 'opencode',
        model: { value: model.id, source: 'dispatched' },
        valuesByModel: {}
      },
      mode: 'draft',
      modelLabel: 'Model',
      liveTransport: 'agent-session'
    })
    expect(draft.find(({ id }) => id === 'effort')).toMatchObject({
      valueSource: 'default',
      kind: { currentValue: 'low' }
    })
    // Shown, never sent: OpenCode picks the same variant itself.
    expect(structuredAgentSessionMessageSelection(pickedModel)).toEqual({ model: model.id })
    expect(structuredAgentSessionSendSelection(pickedModel)).toBeUndefined()
    expect(resolveAgentSessionOptionLaunch('opencode', { model: model.id })).toEqual({
      args: ['--model', model.id],
      appliedValues: { model: model.id }
    })
  })
})
