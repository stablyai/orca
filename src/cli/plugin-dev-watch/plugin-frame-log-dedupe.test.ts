import { describe, expect, it } from 'vitest'
import { formatPluginDevWatchEvent } from './plugin-dev-watch-events'
import { PluginFrameLogDedupe } from './plugin-frame-log-dedupe'

const line = (ts: number, text: string, level = 'warn') => ({ ts, level, line: text })
const KEY_WARNING = '[frame] Each child in a list should have a unique "key"'

describe('PluginFrameLogDedupe', () => {
  it('prints a repeated panel line once per reload with its count, then the later copies', () => {
    const dedupe = new PluginFrameLogDedupe()
    expect(
      dedupe.take([line(1, KEY_WARNING), line(2, 'worker tick', 'info'), line(3, KEY_WARNING)])
    ).toEqual([{ ...line(1, KEY_WARNING), count: 2 }, line(2, 'worker tick', 'info')])
    // Worker lines are never folded; the panel line already printed this reload is only counted.
    expect(
      dedupe.take([line(4, KEY_WARNING), line(5, 'worker tick', 'info'), line(6, KEY_WARNING)])
    ).toEqual([line(5, 'worker tick', 'info')])
    expect(dedupe.flush()).toEqual([{ ...line(6, KEY_WARNING), count: 2, repeat: true }])
    // A new reload prints it again.
    expect(dedupe.take([line(7, KEY_WARNING)])).toEqual([line(7, KEY_WARNING)])
    expect(dedupe.flush()).toEqual([])
  })

  it('keeps the same text at another level apart', () => {
    const dedupe = new PluginFrameLogDedupe()
    expect(dedupe.take([line(1, '[frame] boom'), line(2, '[frame] boom', 'error')])).toHaveLength(2)
  })

  it('shows the count after the line', () => {
    const base = { type: 'log' as const, pluginKey: 'acme.todos', ts: 0, level: 'warn', line: 'x' }
    expect(formatPluginDevWatchEvent({ ...base, count: 3 })).toMatch(/warn {2}x ×3$/)
    expect(formatPluginDevWatchEvent({ ...base, count: 4, repeat: true })).toMatch(
      /warn {2}x \(×4 more\)$/
    )
    expect(formatPluginDevWatchEvent(base)).toMatch(/warn {2}x$/)
  })
})
