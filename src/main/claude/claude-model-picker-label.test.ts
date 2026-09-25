import { expect, it } from 'vitest'
import { listedModels } from './claude-structured-model-catalog'
import { parseClaudeModelList } from '../../shared/claude-model-list-probe'

it('uses identical version labels in terminal discovery and structured sessions without changing model ids', () => {
  const models = [
    { value: 'opus[1m]', displayName: 'Opus (1M context)', resolvedModel: 'claude-opus-5-5[1m]' }
  ]
  const discovered = parseClaudeModelList(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', response: { models } }
    })
  )
  const structured = listedModels({ models })
  expect(discovered[0]).toMatchObject({ id: 'opus[1m]', label: 'Opus 5.5 (1M context)' })
  expect(structured[0]).toMatchObject({ id: discovered[0].id, label: discovered[0].label })
})
