import { expect, it, vi } from 'vitest'
import { PluginAuditLog } from './plugin-audit-log'

const source = vi.hoisted(() => ({ content: '' }))
vi.mock('node:fs/promises', () => ({
  readFile: async (path: string) => (path.endsWith('.1') ? '' : source.content)
}))

it('never yields a record split across a line boundary', async () => {
  source.content = `${Array.from({ length: 3000 }, (_, ts) =>
    JSON.stringify({ ts, summary: `line\\nwith escapes ${'x'.repeat(200)}` })
  ).join('\n')}\n`
  const entries = await new PluginAuditLog('/logs').readRecent(200)
  expect(entries).toHaveLength(200)
  expect(entries.map((entry) => entry.ts)).toEqual(
    Array.from({ length: 200 }, (_, index) => 2800 + index)
  )
  expect(entries.every((entry) => entry.summary.endsWith('x'.repeat(200)))).toBe(true)
})
