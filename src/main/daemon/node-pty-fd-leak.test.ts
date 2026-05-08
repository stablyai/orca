import { execFileSync } from 'child_process'
import { setTimeout as delay } from 'timers/promises'
import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'

function currentRevokedFdCount(): number {
  return execFileSync('lsof', ['-p', String(process.pid)], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes('(revoked)')).length
}

async function spawnExitingPty(index: number): Promise<void> {
  const proc = pty.spawn('/bin/sh', ['-c', 'exit 0'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: { ...process.env, ORCA_FD_LEAK_TEST_INDEX: String(index) }
  })

  await new Promise<void>((resolve) => {
    proc.onExit(() => resolve())
  })
  ;(proc as unknown as { destroy?: () => void }).destroy?.()
}

const describeOnDarwin = process.platform === 'darwin' ? describe : describe.skip

describeOnDarwin('node-pty macOS spawn fd handling', () => {
  it('does not leak revoked slave tty fds across exited pty spawns', async () => {
    const before = currentRevokedFdCount()

    for (let i = 0; i < 50; i++) {
      await spawnExitingPty(i)
    }

    await delay(500)
    const after = currentRevokedFdCount()

    expect(after - before).toBe(0)
  }, 15000)
})
