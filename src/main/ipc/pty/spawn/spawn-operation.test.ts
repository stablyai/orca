// A start opens in one tab list and takes that list's spawn lease: a teammate's own start is never
// refused by, nor wakes, the owner's sleep of the Home (worktree-terminal-sleep-key.ts).
import { expect, it } from 'vitest'
import { runPtySpawn } from './spawn-operation'
import { createRuntimePtySpawnState } from '../runtime/spawn-state'
import type { PtyRuntimeControllerDeps } from '../runtime/controller-deps'
import type { WorktreeTerminalSpawnLeaseOptions } from '../../../runtime/terminal/stop/terminal-update-admission'
import type { TeammateTabListKey } from '../../../bots/team-share/teammate-rules'

const LEASED = new Error('leased')

async function leaseListOf(holder?: TeammateTabListKey) {
  let leased: WorktreeTerminalSpawnLeaseOptions | undefined
  const runtime = {
    acquireWorktreeTerminalSpawn: async (
      _target: unknown,
      opts: WorktreeTerminalSpawnLeaseOptions
    ) => {
      leased = opts
      throw LEASED
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the start reaches only these deps before its lease.
  const deps = {
    runtime,
    getLocalPtyStartupPromise: () => undefined,
    resolvePtySpawnStartupCwd: () => '/'
  } as unknown as PtyRuntimeControllerDeps
  const state = createRuntimePtySpawnState(deps, {
    cols: 80,
    rows: 24,
    worktreeId: 'repo::/w',
    ...(holder ? { holder } : {})
  })
  await expect(
    runPtySpawn({
      state,
      prepare: async () => {},
      facts: () => ({ sessionId: undefined, paneKey: null }),
      commit: async () => {
        throw new Error('unreachable')
      }
    })
  ).rejects.toBe(LEASED)
  return leased?.list
}

it("takes the spawn lease of the list the start opens in, the host's by default", async () => {
  const holder: TeammateTabListKey = 'teammate:bot-1:account-1'
  expect(await leaseListOf(holder)).toBe(holder)
  expect(await leaseListOf()).toBe('host')
})
