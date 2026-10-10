// A running Claude child answers `list_models` from its initialize result for its whole life, so
// the listing it hands the host names that child, which dates every save of it by its first.

import { describe, expect, it } from 'vitest'
import { claudeStructuredSessionOptionsFrom } from './claude-structured-session-options'
import type { ClaudeSession } from './claude-structured-session-state'

const FROZEN_LIST = [
  { value: 'default', resolvedModel: 'claude-sonnet-5' },
  { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5' }
]

describe("a running Claude child's listing for the host catalog", () => {
  it('names the child that listed and the id each alias runs', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the option read touches only these session members.
    const session = {
      acquisitionGeneration: 'child-1',
      options: new Map<string, string>(),
      reportedOptions: {},
      confirmedOptions: new Set<string>(),
      optionMutationSequence: 0,
      reportedModelMutation: -1,
      launchedModel: null
    } as unknown as ClaudeSession

    expect(claudeStructuredSessionOptionsFrom(session, FROZEN_LIST).catalogListing).toMatchObject({
      frozenListingOf: 'child-1',
      models: [{ id: 'sonnet', isDefault: true, resolvedModel: 'claude-sonnet-5' }]
    })
  })
})
