import { describe, expect, it } from 'vitest'
import { isAgentSessionOptions } from '../../../shared/agent-session-record'
import { readNativeSessionOptions } from './structured-agent-session-option-restoration'
import { readNativeHandoffSessionOptions } from './structured-agent-session-handoff-options'

describe.each([readNativeSessionOptions, readNativeHandoffSessionOptions])(
  '%s unknown model',
  (read) => {
    it.each(['', 'selected-model'])('persists only a named model: %j', async (model) => {
      const priorOptions = { model: 'old-guess', effort: 'low', permissionMode: 'acceptEdits' }
      const options = await read({
        sessionId: 'session-1',
        fence: 3,
        priorOptions,
        adapter: { readOptions: async () => ({ models: [], current: { model, effort: 'high' } }) }
      })
      expect(options).toEqual({
        ...(model ? { model } : {}),
        effort: 'high',
        permissionMode: 'acceptEdits'
      })
      expect(isAgentSessionOptions(options)).toBe(true)
      expect(priorOptions.model).toBe('old-guess')
    })
  }
)
