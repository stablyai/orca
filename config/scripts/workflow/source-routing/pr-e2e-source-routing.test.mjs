import { describe, expect, it } from 'vitest'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

describe('direct changed-spec selection', () => {
  it.each([
    'tests/e2e/agents/native-chat/native-chat-automation-saved-card.spec.ts',
    'tests/e2e/agents/native-chat/native-chat-worker-follow-up.spec.ts',
    'tests/e2e/integrations/bots/bot-automation-result-note.spec.ts',
    'tests/e2e/integrations/bots/bot-deep-link.spec.ts',
    'tests/e2e/integrations/bots/bot-item-view-width.spec.ts',
    'tests/e2e/integrations/bots/bot-reveal-current.spec.ts',
    'tests/e2e/integrations/bots/paired-server-bots-survive-disconnect.spec.ts',
    'tests/e2e/integrations/connectors/connector-actions-bot-run.spec.ts',
    'tests/e2e/integrations/connectors/connector-first-setup.spec.ts',
    'tests/e2e/integrations/connectors/orcad-connector-server-bot.spec.ts'
  ])('runs the bot spec %s when only it changes', (spec) => {
    expect(selectPrE2eSpecs([spec])).toContain(spec)
  })
})
