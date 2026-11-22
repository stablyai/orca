import { expect, it } from 'vitest'
import { AcpStructuredOptions } from './acp-structured-options'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import { startOptions } from './acp-agent-test-options.test-fixture'
import { boundAcpOptionWrite } from './acp-session-option-write'

it('invalidates previously applied model and effort when the provider changes them', () => {
  const options = new AcpStructuredOptions(OPENCODE_ACP_DIALECT)
  const response = startOptions
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

it.each([
  ['model', 'opencode/claude-fable-5'],
  ['effort', 'high']
] as const)('forgets a drifting %s reported during an agent write', async (key, value) => {
  const options = new AcpStructuredOptions(OPENCODE_ACP_DIALECT)
  options.adoptSession(startOptions, 'new')
  options.adoptOwnWrite('model', 'opencode/big-pickle')
  options.adoptOwnWrite('effort', 'low')
  const sent = Promise.withResolvers<void>()
  const response = Promise.withResolvers<() => void>()
  const write = boundAcpOptionWrite(
    options,
    { agent: 'opencode2', timeoutMs: 5_000, key: 'agent', value: 'plan' },
    () => {
      sent.resolve()
      return response.promise
    }
  )
  await sent.promise
  const changed = options.configOptions.map((option) =>
    option.type === 'select' && option.id === key ? { ...option, currentValue: value } : option
  )
  options.adoptConfigOptions(changed)
  response.resolve(() => options.adoptConfigOptions(changed))
  await write
  expect(options.appliedInput.has(key)).toBe(false)
  expect(options.appliedInput.get('agent')).toBe('plan')
})
