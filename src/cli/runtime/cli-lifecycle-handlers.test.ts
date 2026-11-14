import '../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, reclaimStaleLockMock, printReclaimResultMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  reclaimStaleLockMock: vi.fn(),
  printReclaimResultMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('../../main/orcad/instance-lock/orcad-stale-lock-reclaim.js', () => ({
  reclaimStaleOrcadInstanceLock: reclaimStaleLockMock,
  printOrcadStaleLockReclaimResult: printReclaimResultMock
}))

// Exclude the socket runtime graph; this handler needs only errors and serveOrcaApp.
vi.mock('./launch', () => ({ serveOrcaApp: vi.fn() }))

import { CORE_HANDLERS } from './cli-lifecycle-handlers'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from './client'

// Emit exit on the next microtask so the spawned-process promise settles deterministically.
function mockClaudeChild(): { once: (event: string, cb: (...args: unknown[]) => void) => unknown } {
  const child = {
    once(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'exit') {
        queueMicrotask(() => cb(0, null))
      }
      return child
    }
  }
  return child
}

describe('orca claude-teams CLI handler', () => {
  let previousRunAsNode: string | undefined
  let previousPaneKey: string | undefined
  let previousExitCode: typeof process.exitCode

  const callMock = vi.fn()
  const client = { call: callMock } as unknown as RuntimeClient

  beforeEach(() => {
    reclaimStaleLockMock.mockReset()
    reclaimStaleLockMock.mockRejectedValue(new Error('Unexpected stale-lock reclaim'))
    printReclaimResultMock.mockReset()
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => mockClaudeChild())
    callMock.mockReset()
    callMock.mockResolvedValue({
      result: {
        launch: { env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', PATH: '/shim:/usr/bin' } }
      }
    })
    previousRunAsNode = process.env.ELECTRON_RUN_AS_NODE
    previousPaneKey = process.env.ORCA_PANE_KEY
    previousExitCode = process.exitCode
    // Reproduce the Electron-as-Node flag inherited from the orca launcher.
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.ORCA_PANE_KEY = 'tab-1:leaf-1'
  })

  afterEach(() => {
    if (previousRunAsNode === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE
    } else {
      process.env.ELECTRON_RUN_AS_NODE = previousRunAsNode
    }
    if (previousPaneKey === undefined) {
      delete process.env.ORCA_PANE_KEY
    } else {
      process.env.ORCA_PANE_KEY = previousPaneKey
    }
    process.exitCode = previousExitCode
  })

  // #32177: an empty --data-root must never fall back to the default profile's lock.
  it('refuses `orca serve --reclaim-stale-lock` with a --data-root that names no directory', async () => {
    const ctx: HandlerContext = {
      flags: new Map<string, string | boolean>([
        ['reclaim-stale-lock', true],
        ['data-root', true],
        ['yes', true]
      ]),
      client,
      cwd: '/tmp',
      json: true,
      rawArgs: []
    }
    await expect(CORE_HANDLERS.serve(ctx)).rejects.toMatchObject({
      code: 'invalid_argument',
      message:
        '--data-root expects a directory. Usage: orca serve --reclaim-stale-lock [--data-root <dir>] [--yes] [--json]'
    })
    expect(reclaimStaleLockMock).not.toHaveBeenCalled()
    expect(printReclaimResultMock).not.toHaveBeenCalled()
  })
})
