import { expect, it } from 'vitest'
import { AcpStructuredOptions } from './acp-structured-options'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import { NewSessionResponseSchema } from '../generated/acp-protocol.generated'
import startOptions from '../fixtures/opencode-v2-start-options.json'

it('exposes only advertised agents and writes the selected native mode', () => {
  const options = new AcpStructuredOptions(OPENCODE_ACP_DIALECT)
  const response = NewSessionResponseSchema.parse(startOptions)
  options.adoptSession(response, 'new')
  expect(options.read()).toMatchObject({
    agents: [{ id: 'build', label: 'Build' }, { id: 'plan', label: 'Plan' }],
    current: { agent: 'build' }
  })
  expect(options.write('agent', 'plan')).toEqual({ method: 'config', configId: 'mode', value: 'plan' })
  expect(options.write('agent', 'unlisted')).toBeNull()
})

it('invalidates previously applied model and effort when the provider changes them', () => {
  const options = new AcpStructuredOptions(OPENCODE_ACP_DIALECT)
  const response = NewSessionResponseSchema.parse(startOptions)
  options.adoptSession(response, 'new')
  options.adoptOwnWrite('model', 'opencode/big-pickle')
  options.adoptOwnWrite('effort', 'low')
  const changed = options.configOptions.map((option) =>
    option.type === 'select' && option.id === 'model'
      ? { ...option, currentValue: 'opencode/claude-fable-5' }
      : option
  )
  options.adoptConfigOptions(changed)
  expect(options.appliedInput.has('model')).toBe(false)
  expect(options.appliedInput.has('effort')).toBe(false)
})
