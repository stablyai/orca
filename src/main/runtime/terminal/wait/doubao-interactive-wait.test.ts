import { expect, it } from 'vitest'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'

// Cropped Doubao CLI 2.37.1 ConPTY screen; the command and QR payload are omitted.
const approval = [
  '  Bash',
  '❯ Allow once',
  '  Reject',
  '  Reject and stop',
  '',
  '',
  '  ↑↓ navigate | Enter / shortcut confirm | Esc stop'
].join('\n')

it('reports the active approval until the decision has been handled', () => {
  expect(detectTerminalWaitBlockedReason(approval)).toBe('agent-approval-prompt')
  expect(
    detectTerminalWaitBlockedReason(
      approval.replace('❯ Allow once\n  Reject', '  Allow once\n❯ Reject')
    )
  ).toBe('agent-approval-prompt')
  expect(detectTerminalWaitBlockedReason(approval.replace('❯', ' '))).toBeNull()
  expect(
    detectTerminalWaitBlockedReason(`${approval}\n◇ Reject · Handled\n❯  Ask Doubao to do anything`)
  ).toBeNull()
})

it('distinguishes a QR sign-in screen from an npm launcher update', () => {
  const footer = '请使用豆包移动端扫码并在手机上确认；按 Ctrl+C 可取消'
  expect(detectTerminalWaitBlockedReason(`  ▀▄█ █▀▄\n${footer}`)).toBe('agent-sign-in-prompt')
  expect(detectTerminalWaitBlockedReason(footer)).toBeNull()
  const update = '检测到豆包 CLI 有可用的新版本：2.37.1 -> 2.37.2。\n是否现在更新？[Y/N]'
  expect(detectTerminalWaitBlockedReason(update)).toBe('agent-update-prompt')
  expect(detectTerminalWaitBlockedReason(`${update}\nN\nDOUBAO CLI`)).toBeNull()
})
