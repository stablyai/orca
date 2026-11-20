import { expect, it } from 'vitest'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

it('selects an allowlisted spec when only that spec changes', () => {
  const spec = 'tests/e2e/integrations/bots/bot-deep-link.spec.ts'
  expect(selectPrE2eSpecs([spec])).toContain(spec)
})
