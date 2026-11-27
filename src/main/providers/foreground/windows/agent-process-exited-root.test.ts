import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveWindowsAgentForegroundProcessWithAvailability,
  type AgentForegroundResolutionOptions
} from './agent-process'
import { reconcileWindowsAgentDecision } from './cached-agent-revalidation'

type Row = { pid: number; ppid: number; name: string; command: string; creationTimeMs?: number }
const host = vi.hoisted((): { rows: Row[]; consoles: number[][] } => ({ rows: [], consoles: [] }))
vi.mock('../../../windows/windows-process-table', () => ({
  readWindowsProcessTableFresh: async () => host.rows,
  readWindowsProcessTable: async () => host.rows
}))

const ROOT_PID = 5368
const SPAWNED_AT = 10_000

function resolve(
  anchor: Pick<AgentForegroundResolutionOptions, 'anchorProcessId' | 'anchorProcessName'> = {}
): ReturnType<typeof resolveWindowsAgentForegroundProcessWithAvailability> {
  return resolveWindowsAgentForegroundProcessWithAvailability(ROOT_PID, 'cmd.exe', {
    ...anchor,
    fresh: true,
    paneSpawnedAtMs: SPAWNED_AT,
    readWindowsConsoleAttachedProcessIds: async (pid) =>
      new Set(host.consoles.find((console) => console.includes(pid)) ?? [])
  })
}

// The pane root (5368) exited after starting the npm shim; Windows keeps its pid on the orphans.
const shim = { pid: 5656, ppid: ROOT_PID, name: 'sh.exe', command: 'sh.exe claude' }
const claude = { pid: 15864, ppid: 5656, name: 'claude.exe', command: 'claude.exe --resume' }

describe('resolveWindowsAgentForegroundProcessWithAvailability after the pane root exits', () => {
  beforeEach(() => {
    host.rows = []
    host.consoles = []
  })

  it('names the agent its orphans keep on the pane console', async () => {
    host.rows = [
      { ...shim, creationTimeMs: SPAWNED_AT + 900 },
      { ...claude, creationTimeMs: SPAWNED_AT + 1_200 }
    ]
    host.consoles = [[shim.pid, claude.pid]]
    await expect(resolve()).resolves.toMatchObject({
      available: true,
      processName: 'claude',
      processId: claude.pid
    })
  })

  it('never credits orphans of an earlier process that held the reused root pid', async () => {
    host.rows = [
      { ...shim, creationTimeMs: SPAWNED_AT - 60_000 },
      { ...claude, creationTimeMs: SPAWNED_AT - 59_000 }
    ]
    host.consoles = [[shim.pid, claude.pid]]
    await expect(resolve()).resolves.toEqual({ available: false, processName: null })
  })

  it('stays unavailable when a direct orphan left the console it was read through', async () => {
    const server = { pid: 7000, ppid: ROOT_PID, name: 'node.exe', command: 'node.exe server.js' }
    host.rows = [
      { ...server, creationTimeMs: SPAWNED_AT + 500 },
      { ...shim, creationTimeMs: SPAWNED_AT + 900 },
      { ...claude, creationTimeMs: SPAWNED_AT + 1_200 }
    ]
    // The shim opened a new console, so the one holding the agent cannot be proven to be the pane's.
    host.consoles = [[server.pid], [shim.pid, claude.pid]]
    await expect(resolve()).resolves.toEqual({ available: false, processName: null })
  })

  it('clears the cached agent once it exits while another orphan keeps the console', async () => {
    const server = { pid: 7000, ppid: ROOT_PID, name: 'node.exe', command: 'node.exe server.js' }
    host.rows = [{ ...server, creationTimeMs: SPAWNED_AT + 500 }]
    host.consoles = [[server.pid]]
    const resolution = await resolve({ anchorProcessId: claude.pid, anchorProcessName: 'claude' })
    // The pane job closed with its root, so job evidence is unavailable and only the scan can retire the anchor.
    const anchor = { processName: 'claude', pid: claude.pid }
    expect(reconcileWindowsAgentDecision(resolution, 'unavailable', anchor, ROOT_PID)).toBeNull()
  })
})
