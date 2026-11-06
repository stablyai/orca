import { describe, expect, it } from 'vitest'
import { readScreenInputVeto } from './terminal/wait/screen-input-veto'
import { detectTerminalWaitBlockedReason } from './terminal/wait/terminal-wait-detection'

// Gates not covered by the recordings, written as AiWork's own strings (en, zh-CN, zh-HK) lay out in
// the line tail: box rows run together behind `┃` because AiWork repaints without newlines.
const MULTI_QUESTION = [
  '┃Color┃Red or blue?┃ 1. [x] Red┃ 2. [ ] Blue┃ 3. Decline all questions┃┃↑↓ Switch options · ←→ switch question · enter Next · esc Exit',
  '┃选择颜色┃红色还是蓝色？┃ 1. [x] 红色┃ 2. [ ] 蓝色┃ 3. 拒绝整组问题┃┃↑↓ 切换选项 · ←→ 切换题目 · enter 下一题 · esc 退出',
  '┃選擇顏色┃紅色還是藍色？┃ 1. [x] 紅色┃ 2. [ ] 藍色┃ 3. 拒絕整組問題┃┃↑↓ 切換選項 · ←→ 切換題目 · enter 審查 · esc 退出'
]
const PLAN_GATE = [
  '┃Plan confirmation┃Review the change plan┃▸ Confirm and execute┃  Cancel┃┃enter confirm current option · esc exit current confirmation',
  '┃Plan 确认┃审查变更 Plan┃▸ 确认并执行┃  取消┃┃enter 确认当前选项 · esc 退出当前确认',
  '┃Plan 確認┃審查變更 Plan┃▸ 確認並執行┃  取消┃┃enter 確認當前選項 · esc 退出當前確認'
]

function blockedReason(tail: string): string | null {
  return detectTerminalWaitBlockedReason(`working…\n${tail}`)
}

describe('AiWork gate text', () => {
  it.each(MULTI_QUESTION)('blocks the multi-question box %s', (tail) => {
    expect(blockedReason(tail)).toBe('agent-interactive-prompt')
  })

  it.each(PLAN_GATE)('blocks the plan confirmation %s', (tail) => {
    expect(blockedReason(tail)).toBe('agent-interactive-prompt')
  })

  it('clears an answered box once the composer and mode row come back', () => {
    expect(
      blockedReason(
        `${PLAN_GATE[0]}● Done.────────❱ Type a message, Enter to send────────◆ Agent · ◆ Manual authorization · model`
      )
    ).toBeNull()
  })

  it('keeps blocking when `❱` appears without the composer that follows it', () => {
    expect(blockedReason(`see ❱ in the docs ${PLAN_GATE[0]}`)).toBe('agent-interactive-prompt')
    expect(blockedReason(`${PLAN_GATE[0]} pasted ❱ glyph`)).toBe('agent-interactive-prompt')
  })

  it('keeps blocking when the pane does not show the AiWork mode row', () => {
    expect(blockedReason(`${PLAN_GATE[0]}────────❱ Type a message────────`)).toBe(
      'agent-interactive-prompt'
    )
  })

  it('does not read the plan review keys in prose as the review', () => {
    expect(blockedReason('working…\nPress Discard(r) to drop the plan, or Close(Esc).')).toBeNull()
  })

  it('vetoes a question box whose footer starts with another key', () => {
    const lines = [
      '  ┃   3. Decline all questions',
      '  ┃',
      '  ┃  ←→ switch question · space Select/Deselect · enter Confirm · esc Exit'
    ]
    expect(readScreenInputVeto('aiwork', () => ({ lines, alternateScreen: false }))).toBe(true)
  })

  it('does not read option letters in ordinary output as the plan review', () => {
    const lines = [
      '   ❱ compare plan (a) with (m), then (r) and (y)',
      '  ◆ Agent · ◆ Manual authorization'
    ]
    expect(readScreenInputVeto('aiwork', () => ({ lines, alternateScreen: false }))).toBe(false)
  })
})
