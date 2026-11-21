import { expect, it } from 'vitest'
import { createMessageGraphSessionResumeState } from '../session-scanner-graph-parsers'

async function piTitle(names: string[]): Promise<string | undefined> {
  const state = createMessageGraphSessionResumeState('pi', {
    path: '/sessions/pi-session.jsonl',
    mtimeMs: 1,
    modifiedAt: '2026-01-01T00:00:00.000Z'
  })
  const lines = [
    { type: 'session', id: 'pi-session', cwd: '/repo' },
    {
      type: 'message',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Investigate delivery' }] }
    },
    ...names.map((name, index) => ({
      type: 'session_info',
      name,
      timestamp: `2026-01-01T00:00:0${index + 2}.000Z`
    }))
  ]
  for (const line of lines) {
    state.consumeLine(JSON.stringify(line))
  }
  return (await state.finalize(process.platform, {}))?.title
}

it('titles a Pi session with its latest /name instead of the first prompt', async () => {
  expect(await piTitle(['Old name', 'Delivery investigation'])).toBe('Delivery investigation')
})

it('falls back to the first prompt after a Pi name is cleared', async () => {
  expect(await piTitle(['Old name', ''])).toBe('Investigate delivery')
})
