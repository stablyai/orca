import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import { resolveDefaultCwd } from './pty-shell-utils'
import {
  beginPtyHandlerTest,
  createPtyRequestHelpers,
  endPtyHandlerTest
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

const FOLDER_WORKSPACE_ID = 'folder:b1706d92-9d05-4932-8360-01e00b54305a'
const FOLDER_PATH = '/opt/tiger/workspace'
const WORKTREE_ID = 'repo-1::/srv/repo'

// Why (STA-4746): pins that the relay reads cwd from the request, never from
// parsing ORCA_WORKTREE_ID. Request construction: tests/e2e/sta4746-*.spec.ts.
describe('relay PTY spawn cwd for folder workspaces', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  const { spawnPty } = createPtyRequestHelpers(() => dispatcher)

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  function spawnedCwd(): string | undefined {
    return mockPtySpawn.mock.calls.at(-1)?.[2]?.cwd
  }

  it('spawns a folder-workspace PTY in the requested workspace path', async () => {
    await spawnPty({
      cwd: FOLDER_PATH,
      worktreeId: FOLDER_WORKSPACE_ID,
      env: {
        ORCA_WORKSPACE_ID: FOLDER_WORKSPACE_ID,
        ORCA_WORKTREE_ID: FOLDER_WORKSPACE_ID,
        ORCA_WORKSPACE_ROOT: FOLDER_PATH
      }
    })
    expect(spawnedCwd()).toBe(FOLDER_PATH)
  })

  it('spawns a folder-workspace PTY in the requested path with no ORCA_WORKSPACE_ROOT', async () => {
    await spawnPty({
      cwd: FOLDER_PATH,
      worktreeId: FOLDER_WORKSPACE_ID,
      env: { ORCA_WORKTREE_ID: FOLDER_WORKSPACE_ID }
    })
    expect(spawnedCwd()).toBe(FOLDER_PATH)
  })

  it('keeps worktree-style ids on the request cwd, not the id-derived path', async () => {
    await spawnPty({
      cwd: '/srv/repo/packages/app',
      worktreeId: WORKTREE_ID,
      env: { ORCA_WORKTREE_ID: WORKTREE_ID }
    })
    expect(spawnedCwd()).toBe('/srv/repo/packages/app')
  })

  it('honours a legacy client that sends only env.ORCA_WORKTREE_ID', async () => {
    // Why: clients before the `worktreeId` spawn param (<= 1.4.184) carried the
    // workspace id in env only. cwd has always been an explicit request field.
    await spawnPty({
      cwd: FOLDER_PATH,
      env: {
        ORCA_WORKTREE_ID: FOLDER_WORKSPACE_ID,
        ORCA_WORKSPACE_ROOT: FOLDER_PATH
      }
    })
    expect(spawnedCwd()).toBe(FOLDER_PATH)
  })

  it('falls back to the default cwd only when the request carries none', async () => {
    // Why: ORCA_WORKSPACE_ROOT is a client-supplied path and is deliberately not
    // promoted to a cwd fallback — the relay would be trusting an unvalidated
    // remote path for a request that named no working directory at all.
    await spawnPty({
      env: {
        ORCA_WORKTREE_ID: FOLDER_WORKSPACE_ID,
        ORCA_WORKSPACE_ROOT: FOLDER_PATH
      }
    })
    expect(spawnedCwd()).not.toBe(FOLDER_PATH)
    // Why computed: the harness pins platform to linux, but HOME is unset on
    // some CI images, where the default falls through to homedir().
    expect(spawnedCwd()).toBe(resolveDefaultCwd(process.env, 'linux'))
  })
})
