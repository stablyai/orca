import { execFileSync } from 'child_process'
import { existsSync, renameSync } from 'fs'
import { setTimeout as delay } from 'timers/promises'
import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'
import { getNodePtySpawnHelperCandidates } from '../providers/local-pty-utils'

function currentRevokedFdCount(): number {
  return execFileSync('lsof', ['-p', String(process.pid)], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes('(revoked)')).length
}

function currentOpenFdCount(): number {
  return execFileSync('lsof', ['-p', String(process.pid)], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.trim().length > 0).length
}

function getExistingSpawnHelper(): string {
  const helperPath = getNodePtySpawnHelperCandidates().find((candidate) => existsSync(candidate))
  expect(helperPath).toBeTruthy()
  return helperPath as string
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

  it('does not leak fds when native posix_spawn setup fails', async () => {
    const helperPath = getExistingSpawnHelper()
    const hiddenHelperPath = `${helperPath}.orca-test-hidden`
    expect(existsSync(hiddenHelperPath)).toBe(false)

    const before = currentOpenFdCount()
    renameSync(helperPath, hiddenHelperPath)
    try {
      for (let i = 0; i < 20; i++) {
        expect(() =>
          pty.spawn('/bin/sh', ['-c', 'exit 0'], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: process.cwd(),
            env: { ...process.env, ORCA_FD_LEAK_TEST_INDEX: String(i) }
          })
        ).toThrow(/node-pty: posix_spawn failed: ENOENT/)
      }
    } finally {
      renameSync(hiddenHelperPath, helperPath)
    }

    await delay(500)
    const after = currentOpenFdCount()

    expect(after - before).toBe(0)
  }, 15000)
})
