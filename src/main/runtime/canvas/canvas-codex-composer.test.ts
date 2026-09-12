import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from '../../daemon/headless-emulator'
import { projectTerminalVisibleLines } from '../orca-runtime-terminal-projection'
import { canvasMessagingFixture } from './canvas-messaging-test-fixture'

const particle = '\x1b[38;2;163;165;165m⠁\x1b[0m'
const placeholder = '\x1b[2mAsk Codex to do anything\x1b[0m'

async function composer(text = placeholder, cursorColumn = 3) {
  const emulator = new HeadlessEmulator({ cols: 80, rows: 12 })
  await emulator.write(
    `${particle}\r\n\x1b[1m›\x1b[0m ${text}  ${particle}\r\n` +
      `${particle}\r\n\x1b[38;2;163;165;165mgpt-6-astra high · ~/repo\x1b[0m` +
      `\x1b[2;${cursorColumn}H\x1b[?25h`
  )
  return emulator
}

describe('Codex animated composer delivery', () => {
  it('delivers a peer question through the real screen projection despite placeholder particles', async () => {
    const emulator = await composer()
    const f = await canvasMessagingFixture()
    try {
      f.runtime.getTerminalAgentStatus.mockResolvedValue({ isRunningAgent: true, status: 'idle' })
      f.runtime.readTerminal.mockImplementation(async () => ({
        source: 'screen',
        draft: '',
        composerReady: false,
        ...projectTerminalVisibleLines(emulator)
      }))
      const message = f.service.send(f.input())
      await f.settle()
      await f.service.flush()
      expect(f.runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
      expect(f.journal.get(message.id)?.state).toBe('delivered')
    } finally {
      f.service.stop()
      f.db.close()
      emulator.dispose()
    }
  })

  it.each([
    ['unfinished user request', 26],
    ['⠁', 3],
    ['Ask Codex to do anything', 3],
    [`typed${placeholder}`, 8]
  ])('never treats real input as an empty animated composer: %s', async (text, column) => {
    const emulator = await composer(text, column)
    try {
      expect(projectTerminalVisibleLines(emulator).composerReady).toBe(false)
    } finally {
      emulator.dispose()
    }
  })
})
