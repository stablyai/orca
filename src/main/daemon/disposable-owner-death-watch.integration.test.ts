import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DisposableOwnerDeathWatch } from './disposable-owner-death-watch'
import { proveDaemonExited, stateDeletionIsSafe } from '../startup/disposable-profile-teardown'

/** The incident with real processes and the real watch class.
 *
 *  A graceful will-quit path proves nothing here: the candidate runtimes died
 *  without ever running one. What has to hold is that the daemon retires on its
 *  OWNER's death, takes its supervised session with it, and that the state root
 *  is only deleted once both are provably gone. */
describe('a disposable daemon and its descendants exit before state deletion', () => {
  it('retires on real owner death and takes its session with it', { timeout: 30_000 }, async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'orca-disposable-'))
    const pidRecord = join(stateRoot, 'daemon.pid')

    const idle = ['-e', 'setInterval(() => {}, 1000)']
    const owner = await spawnIdle(idle)
    // Stands in for the daemon process and the agent session it supervises.
    const daemon = await spawnIdle(idle)
    const session = await spawnIdle(idle)
    writeFileSync(pidRecord, JSON.stringify({ pid: daemon.pid }))

    // Exactly how daemon-entry wires it: the production watch, retiring into the
    // same shutdown that kills every supervised session.
    let retiredWith: number | null = null
    const watch = new DisposableOwnerDeathWatch({
      ownerPid: owner.pid as number,
      intervalMs: 25,
      onRetire: ({ ownerPid }) => {
        retiredWith = ownerPid
        session.kill('SIGKILL')
        daemon.kill('SIGKILL')
      }
    })
    watch.start()

    // Before: the owner is alive, nothing retires, and the state root must stay.
    watch.check()
    expect(retiredWith).toBeNull()
    expect(stateDeletionIsSafe(proveDaemonExited(pidRecord))).toBe(false)

    owner.kill('SIGKILL')
    await waitFor(() => retiredWith !== null)
    await waitFor(() => !alive(daemon.pid as number) && !alive(session.pid as number))

    expect(retiredWith).toBe(owner.pid)
    // Only now is deleting the state root safe. Fifteen roots were deleted while
    // their daemon and sessions were still running, which is what made the
    // survivors unfindable.
    const proof = proveDaemonExited(pidRecord)
    expect(proof.verdict).toBe('exited')
    expect(stateDeletionIsSafe(proof)).toBe(true)
    watch.stop()
    rmSync(stateRoot, { recursive: true, force: true })
    expect(existsSync(stateRoot)).toBe(false)
  })
})

async function spawnIdle(args: readonly string[]): Promise<ChildProcess> {
  const child = spawn(process.execPath, [...args], { stdio: 'ignore' })
  await new Promise((resolve) => child.once('spawn', resolve))
  return child
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for condition')
}
