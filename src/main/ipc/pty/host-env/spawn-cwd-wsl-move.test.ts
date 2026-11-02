import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveCutoverFixture as cutover } from '../../../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  WslMoveProjectFencedError,
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../../../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { assertWorkspaceAcceptsNewPty } from './spawn-cwd'

const { listLiveDaemonPtyIds } = vi.hoisted(() => ({
  listLiveDaemonPtyIds: vi.fn<() => Promise<string[] | null>>()
}))
vi.mock('../../../daemon/daemon-provider-state', () => ({ listLiveDaemonPtyIds }))

let userDataPath: string
// No store: a readable journal never needs one.
const accept = (worktreeId: string, sessionId?: string) =>
  Promise.resolve(assertWorkspaceAcceptsNewPty(undefined, worktreeId, sessionId))

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-spawn-'))
  loadWslMoveFence(userDataPath)
  seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
  listLiveDaemonPtyIds.mockReset()
})
afterEach(() => {
  resetWslMoveFenceForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('assertWorkspaceAcceptsNewPty under a WSL move', () => {
  it('refuses a fresh terminal in a moving project and never asks the daemon', async () => {
    await expect(accept('repo-1::/x')).rejects.toBeInstanceOf(WslMoveProjectFencedError)
    expect(listLiveDaemonPtyIds).not.toHaveBeenCalled()
  })

  it('lets a reload reattach a session the daemon still runs', async () => {
    listLiveDaemonPtyIds.mockResolvedValue(['repo-1::/x@@1'])
    await expect(accept('repo-1::/x', 'repo-1::/x@@1')).resolves.toBeUndefined()
  })

  it.each([
    ['an exited session (a cold restore)', ['other@@2']],
    ['an unanswered census', null]
  ])('refuses %s', async (_label, live) => {
    listLiveDaemonPtyIds.mockResolvedValue(live)
    await expect(accept('repo-1::/x', 'repo-1::/x@@1')).rejects.toBeInstanceOf(
      WslMoveProjectFencedError
    )
  })

  it('leaves other projects alone', async () => {
    await expect(accept('repo-2::/x')).resolves.toBeUndefined()
  })
})
