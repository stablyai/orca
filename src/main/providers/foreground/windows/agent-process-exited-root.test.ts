import { beforeEach, describe, expect, it, vi } from 'vitest'

const { tableRows } = vi.hoisted(() => ({
  tableRows: { current: [] as { pid: number; ppid: number; name: string; command: string }[] }
}))

vi.mock('../../../windows/windows-process-table', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // A new array per read, like the native reader, so cached projections never leak between cases.
  readWindowsProcessTable: vi.fn(async () => [...tableRows.current]),
  readWindowsProcessTableFresh: vi.fn(async () => [...tableRows.current])
}))

import { resolveWindowsAgentForegroundProcessWithAvailability } from './agent-process'

const DEAD_ROOT = 5368
const ORPHAN_SH = {
  pid: 5656,
  ppid: DEAD_ROOT,
  name: 'sh.exe',
  command:
    '"C:\\Program Files\\Git\\usr\\bin\\sh.exe" /c/Users/me/AppData/Roaming/npm/claude --resume abc'
}
const ORPHAN_CLAUDE = {
  pid: 15864,
  ppid: 5656,
  name: 'claude.exe',
  command:
    'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe --resume abc'
}

describe('resolveWindowsAgentForegroundProcessWithAvailability when the pane root has exited', () => {
  beforeEach(() => {
    tableRows.current = [ORPHAN_SH, ORPHAN_CLAUDE]
  })

  it('finds the agent the exited root left running', async () => {
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', { fresh: true })
    ).resolves.toMatchObject({ available: true, processName: 'claude', processId: 15864 })
  })

  it('stays unavailable on a cached table, which may be stale', async () => {
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', {})
    ).resolves.toEqual({ available: false, processName: null })
  })

  it('never proves a shell from orphans that hold no agent', async () => {
    tableRows.current = [
      { pid: 7000, ppid: DEAD_ROOT, name: 'node.exe', command: 'node server.js' }
    ]
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', { fresh: true })
    ).resolves.toEqual({ available: false, processName: null })
  })

  it('stays unavailable when the root left no orphans', async () => {
    tableRows.current = []
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', { fresh: true })
    ).resolves.toEqual({ available: false, processName: null })
  })

  it('checks console membership through a direct orphan', async () => {
    const readConsole = vi.fn(async () => new Set([5656, 15864]))
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', {
        fresh: true,
        readWindowsConsoleAttachedProcessIds: readConsole
      })
    ).resolves.toMatchObject({ available: true, processName: 'claude' })
    expect(readConsole).toHaveBeenCalledWith(5656)
  })

  it('stays unavailable when console membership cannot be read', async () => {
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', {
        fresh: true,
        readWindowsConsoleAttachedProcessIds: async () => null
      })
    ).resolves.toEqual({ available: false, processName: null })
  })

  it('does not credit an agent attached to another console', async () => {
    // A plain shell orphan stays on this console; the agent below it has detached.
    tableRows.current = [{ ...ORPHAN_SH, command: 'sh.exe' }, ORPHAN_CLAUDE]
    const result = await resolveWindowsAgentForegroundProcessWithAvailability(
      DEAD_ROOT,
      'bash.exe',
      { fresh: true, readWindowsConsoleAttachedProcessIds: async () => new Set([5656]) }
    )
    expect(result.processName).not.toBe('claude')
  })

  it('keeps attaching through a live root', async () => {
    tableRows.current = [
      { pid: DEAD_ROOT, ppid: 1, name: 'bash.exe', command: 'bash.exe' },
      ORPHAN_SH,
      ORPHAN_CLAUDE
    ]
    const readConsole = vi.fn(async () => new Set([DEAD_ROOT, 5656, 15864]))
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', {
        fresh: true,
        readWindowsConsoleAttachedProcessIds: readConsole
      })
    ).resolves.toMatchObject({ available: true, processName: 'claude' })
    expect(readConsole).toHaveBeenCalledWith(undefined)
  })
})
