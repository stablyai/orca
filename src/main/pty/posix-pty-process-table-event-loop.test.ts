import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signalPosixPtyForegroundGroup } from './posix-pty-foreground-group'
import { forceKillPosixPtyProcessGroups } from './posix-pty-process-groups'

const describeOnPosix = process.platform === 'win32' ? describe.skip : describe

// A wedged ps must time out off the event loop; the daemon froze while kill and resize waited on it (#34410).
describeOnPosix('PTY process-table reads with a ps that never exits', () => {
  let stubDir = ''
  let originalPath: string | undefined

  beforeAll(() => {
    stubDir = mkdtempSync(join(tmpdir(), 'orca-hung-ps-'))
    writeFileSync(join(stubDir, 'ps'), '#!/bin/sh\nexec sleep 30\n')
    chmodSync(join(stubDir, 'ps'), 0o755)
    originalPath = process.env.PATH
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`
  })

  afterAll(() => {
    process.env.PATH = originalPath
    rmSync(stubDir, { recursive: true, force: true })
  })

  async function recordOrder(run: (fallback: () => void) => unknown): Promise<string[]> {
    const order: string[] = []
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        order.push('timer')
        resolve()
      }, 0)
    )
    await run(() => order.push('fallback'))
    await timer
    return order
  }

  it('lets a concurrent timer run while force-kill waits for the process table', async () => {
    const order = await recordOrder((fallback) => forceKillPosixPtyProcessGroups(999_999, fallback))
    expect(order).toEqual(['timer', 'fallback'])
  })

  it('lets a concurrent timer run while resize waits for the foreground group', async () => {
    const order = await recordOrder((fallback) =>
      signalPosixPtyForegroundGroup(999_999, '/dev/ttys999', 'SIGWINCH', fallback)
    )
    expect(order).toEqual(['timer', 'fallback'])
  })
})
