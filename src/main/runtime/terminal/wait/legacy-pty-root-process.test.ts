import { expect, it } from 'vitest'
import { readLegacyPtyRootProcessId } from './legacy-pty-root-process'

it.skipIf(process.platform === 'win32').each([
  [10, 10],
  [100, 100]
])(
  'an older daemon lists its sessions once per held terminal, not once per retry (%i held, %i sessions)',
  async (held, sessions) => {
    let rowsReturned = 0
    const controller = {
      listProcesses: async () => {
        rowsReturned += sessions
        return Array.from({ length: sessions }, (_, index) => ({
          id: `pty-${held}-${index}`,
          incarnationId: 'incarnation-1',
          rootProcessId: process.pid,
          cwd: '',
          title: ''
        }))
      }
    }
    for (let wave = 0; wave < 12; wave++) {
      for (let index = 0; index < held; index++) {
        await expect(
          readLegacyPtyRootProcessId(controller, `pty-${held}-${index}`, 'incarnation-1')
        ).resolves.toBe(process.pid)
      }
    }
    expect(rowsReturned).toBe(held * sessions)
  }
)
