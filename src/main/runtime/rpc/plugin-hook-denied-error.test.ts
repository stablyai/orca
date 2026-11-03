import { describe, expect, it } from 'vitest'
import { PluginHookDeniedError } from '../../plugins/hooks/plugin-hook-dispatch'
import { mapDispatcherError } from './dispatcher-error-response'

describe('a plugin hook denial over RPC', () => {
  it('answers denied_by_plugin naming the plugin and its reason', () => {
    const response = mapDispatcherError(
      { id: '1', authToken: 't', method: 'terminal.send' },
      { runtimeId: 'r' },
      new PluginHookDeniedError('terminal.send', 'acme.guard', 'no rm')
    )
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'denied_by_plugin',
        message: 'terminal.send denied by plugin acme.guard: no rm',
        data: { event: 'terminal.send', pluginKey: 'acme.guard', reason: 'no rm' }
      }
    })
  })
})
