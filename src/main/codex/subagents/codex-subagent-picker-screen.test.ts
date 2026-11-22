import { expect, it } from 'vitest'
import { codexSubagentPickerKeys, readCodexSubagentPicker } from './codex-subagent-picker-screen'

const screen = [
  '• Waiting for agents',
  '  Subagents',
  '  Select an agent to watch. ⌥← previous, ⌥→ next.',
  '',
  '› 1. • Main [default] (current)  01a1ad81-fc8a-76a1-ba85-ed850ed0db84',
  '  2. • /root/alpha_probe         01a1ad82-4b9b-7d30-b9c8-316f3e47a766',
  '  3. • /root/beta_probe          01A1AD82-5751-7AD2-86BF-1758D73A5C9C',
  '  enter select · esc back'
]

it('reads picker rows with their thread ids and highlight', () => {
  expect(readCodexSubagentPicker(screen)).toEqual([
    { index: 1, threadId: '01a1ad81-fc8a-76a1-ba85-ed850ed0db84', highlighted: true },
    { index: 2, threadId: '01a1ad82-4b9b-7d30-b9c8-316f3e47a766', highlighted: false },
    { index: 3, threadId: '01a1ad82-5751-7ad2-86bf-1758d73a5c9c', highlighted: false }
  ])
  expect(readCodexSubagentPicker(screen.slice(0, 2))).toBeNull()
})

it('selects by number, and by arrows from the highlight past nine', () => {
  const rows = [
    { index: 9, threadId: 'a', highlighted: false },
    { index: 10, threadId: 'b', highlighted: true },
    { index: 12, threadId: 'c', highlighted: false }
  ]
  expect(codexSubagentPickerKeys(rows, rows[0]!)).toBe('9')
  expect(codexSubagentPickerKeys(rows, rows[2]!)).toBe('\x1b[B\x1b[B\r')
})
