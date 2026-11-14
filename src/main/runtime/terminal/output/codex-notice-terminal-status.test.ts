import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import { observeCodexCapacityTerminalStatus } from './codex-notice-terminal-status'

const transcript = readFileSync(
  new URL('../../__fixtures__/codex-model-capacity.txt', import.meta.url),
  'utf8'
)
void readFileSync(
  new URL('../../__fixtures__/codex-model-capacity-fullscreen.txt', import.meta.url),
  'utf8'
)

describe('Codex model capacity terminal status', () => {
  it.each([100, 101])(
    'does not close a hook turn starting at or after output time (%i)',
    async (turnStartedAt) => {
      const emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      try {
        await emulator.write(transcript)
        expect(
          observeCodexCapacityTerminalStatus(
            emulator,
            transcript,
            undefined,
            'codex',
            () => ({
              agentType: 'codex',
              prompt: 'Retry',
              turnStartedAt
            }),
            100
          )
        ).toBeNull()
      } finally {
        emulator.dispose()
      }
    }
  )
})
