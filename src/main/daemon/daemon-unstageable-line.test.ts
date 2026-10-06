import './mock-descendant-sweep'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonServer } from './daemon-server'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

const describePosix = process.platform === 'win32' ? describe.skip : describe

// Why (stack QA 2a follow-up): with this machine's temp folder unusable, an AI button's or a note's
// long prompt was typed raw where main pasted it, and could be lost; those callers ask to refuse.
describePosix('an agent line the daemon cannot stage, sent over the daemon wire', () => {
  let dir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let sub: ReturnType<typeof createMockSubprocess>
  const command = `claude 'one\ntwo'`

  beforeEach(async () => {
    sub = { ...createMockSubprocess(), shellPath: '/bin/zsh' }
    ;({ dir, server, adapter } = await startDaemonAdapterHarness(() => sub))
    // After the harness, so only staging meets the missing folder.
    vi.stubEnv('TMPDIR', join(dir, 'missing'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is refused with the prompt’s reason when the caller asks to refuse it', async () => {
    await expect(
      adapter.spawn({
        cols: 80,
        rows: 24,
        command,
        launchAgent: 'claude',
        unstageableLine: 'refuse'
      })
    ).rejects.toThrow(/launch_file_unavailable/)
    expect(sub.write).not.toHaveBeenCalled()
  })

  // The same as a daemon that predates the optional field, which never reads it. The line waits
  // for the shell's ready marker, which this mock never prints, so the session is the evidence.
  it('is created to type the line as is without the field', async () => {
    await expect(
      adapter.spawn({ cols: 80, rows: 24, command, launchAgent: 'claude' })
    ).resolves.toMatchObject({ id: expect.any(String) })
  })
})
