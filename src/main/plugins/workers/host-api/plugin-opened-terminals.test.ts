import { describe, expect, it } from 'vitest'
import {
  PLUGIN_OPENED_TERMINAL_LIMIT,
  installPluginOpenedTerminalPruning,
  isPluginOpenedTerminal,
  recordPluginOpenedTerminal
} from './plugin-opened-terminals'

describe('terminals a plugin opened', () => {
  it('are forgotten once its worker stops or it loses approval', () => {
    let notify = () => {}
    const workers: Record<string, 'running' | 'inactive'> = {
      'a.one': 'running',
      'a.two': 'running'
    }
    const approved = new Set(['a.one', 'a.two'])
    installPluginOpenedTerminalPruning({
      onChanged: (listener) => {
        notify = listener
        return () => {}
      },
      findApprovedPlugin: (key) => (approved.has(key) ? {} : null),
      workerState: (key) => ({ state: workers[key] ?? 'inactive' })
    })
    recordPluginOpenedTerminal('a.one', 'term_1')
    recordPluginOpenedTerminal('a.two', 'term_2')
    notify()
    expect(isPluginOpenedTerminal('a.one', 'term_1')).toBe(true)
    workers['a.one'] = 'inactive'
    approved.delete('a.two')
    notify()
    expect(isPluginOpenedTerminal('a.one', 'term_1')).toBe(false)
    expect(isPluginOpenedTerminal('a.two', 'term_2')).toBe(false)
  })

  it('keeps only the newest per plugin', () => {
    for (let index = 0; index <= PLUGIN_OPENED_TERMINAL_LIMIT; index += 1) {
      recordPluginOpenedTerminal('a.many', `term_${index}`)
    }
    expect(isPluginOpenedTerminal('a.many', 'term_0')).toBe(false)
    expect(isPluginOpenedTerminal('a.many', `term_${PLUGIN_OPENED_TERMINAL_LIMIT}`)).toBe(true)
  })
})
