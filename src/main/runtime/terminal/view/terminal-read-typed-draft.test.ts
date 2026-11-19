import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import { projectTerminalVisibleLines } from './orca-runtime-terminal-projection'

async function project(data: string) {
  const emulator = new HeadlessEmulator({ cols: 80, rows: 8 })
  try {
    await emulator.write(data)
    return projectTerminalVisibleLines(emulator)
  } finally {
    emulator.dispose()
  }
}

describe('terminal read composer draft', () => {
  it('omits a dim prompt suggestion that the user has not typed', async () => {
    const frame = '─'.repeat(80)
    const projection = await project(
      `${frame}\r\n❯ \x1b[2mproceed with the release\r\n  and close the pull request\x1b[22m\x1b[1A\x1b[3G`
    )
    expect(projection.draft).toBeUndefined()
    expect(projection.lines.join('\n')).not.toContain('proceed with the release')
  })

  it('keeps typed text when the caret sits on a dim completion', async () => {
    const frame = '─'.repeat(80)
    const projection = await project(
      `\x1b[?25l${frame}\r\n❯ /mo\x1b7\x1b[7md\x1b[27m\x1b[2mel\x1b[22m\r\n${frame}\x1b8`
    )
    expect(projection.draft).toBe('/mo')
  })

  it('keeps a draft the user typed', async () => {
    const frame = '─'.repeat(80)
    const projection = await project(`${frame}\r\n❯ ship it`)
    expect(projection.draft).toBe('ship it')
  })
})
