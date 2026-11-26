import { NewSessionResponseSchema } from '../generated/acp-protocol.generated'

export const startOptions = NewSessionResponseSchema.parse({
  sessionId: 'ses_test',
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'opencode/big-pickle',
      options: [
        { value: 'opencode/big-pickle', name: 'Big Pickle' },
        { value: 'opencode/claude-fable-5', name: 'Fable' }
      ]
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' }
      ]
    },
    {
      id: 'mode',
      name: 'Agent',
      category: 'mode',
      type: 'select',
      currentValue: 'build',
      options: [
        { value: 'build', name: 'Build' },
        { value: 'plan', name: 'Plan' }
      ]
    }
  ]
})
