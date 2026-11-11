import { expect, it } from 'vitest'

import { searchMessageRows } from './session-search-message-rows'
import './session-search-index-test-fixture'

it('drops tool output and preserves the full conversation', () => {
  const output = `pericardium ${'padding '.repeat(140_000)}`
  expect([...searchMessageRows([{ role: 'tool', text: output, timestamp: null }])]).toEqual([])
  const rows = [...searchMessageRows([{ role: 'assistant', text: output, timestamp: null }])]
  expect(rows.map((row) => row.text).join('')).toBe(output)
})
