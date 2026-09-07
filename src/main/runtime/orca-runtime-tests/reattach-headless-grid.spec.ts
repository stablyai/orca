import { describe, expect, it } from 'vitest'
import { createRuntime, syncSinglePty } from '../orca-runtime-test-fixtures.spec'

describe('headless model grid after a reattach', () => {
  it('reflows a model that live bytes created at the 80x24 default onto the PTY grid', async () => {
    const runtime = createRuntime()
    // No controller size: mirrors a reattach whose real grid main only learns from the reply.
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => null
    })
    syncSinglePty(runtime, 'pty-1')

    runtime.onPtyData('pty-1', 'user@host % claude\r\n', 100)
    await expect(
      runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 100 })
    ).resolves.toMatchObject({ cols: 80, rows: 24 })

    runtime.reflowHeadlessTerminalToPtyGrid('pty-1', 211, 57)

    await expect(
      runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 100 })
    ).resolves.toMatchObject({ cols: 211, rows: 57, source: 'headless' })
  })

  it('never creates a model for a PTY that has none', async () => {
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => null
    })
    syncSinglePty(runtime, 'pty-1')

    runtime.reflowHeadlessTerminalToPtyGrid('pty-1', 211, 57)
    runtime.onPtyData('pty-1', 'hello\r\n', 100)

    // Why it matters: commit reflows every reattach, and pre-creating here would defeat the
    // renderer-authority gate that deliberately leaves the model unseeded.
    await expect(
      runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 100 })
    ).resolves.toMatchObject({ cols: 80, rows: 24 })
  })
})
