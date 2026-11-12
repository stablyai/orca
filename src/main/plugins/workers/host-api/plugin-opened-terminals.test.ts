import { describe, expect, it } from 'vitest'
import {
  PLUGIN_OPENED_TERMINAL_LIMIT,
  installPluginOpenedTerminalPruning,
  isPluginOpenedTerminal,
  recordPluginOpenedTerminal
} from './plugin-opened-terminals'

describe('terminals a plugin opened', () => {
  it('are forgotten once the plugin is disabled or removed, not when its worker stops', () => {
    let notify = () => {}
    const approved = new Set(['a.one', 'a.two'])
    installPluginOpenedTerminalPruning({
      onChanged: (listener) => {
        notify = listener
        return () => {}
      },
      findApprovedPlugin: (key) => (approved.has(key) ? {} : null)
    })
    recordPluginOpenedTerminal('a.one', 'term_1')
    recordPluginOpenedTerminal('a.two', 'term_2')
    // An idle reap or restart notifies too; both plugins stay approved.
    notify()
    expect(isPluginOpenedTerminal('a.one', 'term_1')).toBe(true)
    approved.delete('a.two')
    notify()
    expect(isPluginOpenedTerminal('a.one', 'term_1')).toBe(true)
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
