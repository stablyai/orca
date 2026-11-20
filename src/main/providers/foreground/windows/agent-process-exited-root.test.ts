import { beforeEach, describe, expect, it, vi } from 'vitest'

const { tableRows } = vi.hoisted(() => {
  const current: {
    pid: number
    ppid: number
    name: string
    command: string
    creationTimeMs?: number
  }[] = []
  return { tableRows: { current } }
})

vi.mock('../../../windows/windows-process-table', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // A new array per read, like the native reader, so cached projections never leak between cases.
  readWindowsProcessTable: vi.fn(async () => [...tableRows.current]),
  readWindowsProcessTableFresh: vi.fn(async () => [...tableRows.current])
}))

import { resolveWindowsAgentForegroundProcessWithAvailability } from './agent-process'

const DEAD_ROOT = 5368
const SPAWNED = 1000
const BORN = 2000
const ORPHAN_SH = {
  pid: 5656,
  ppid: DEAD_ROOT,
  name: 'sh.exe',
  command:
    '"C:\\Program Files\\Git\\usr\\bin\\sh.exe" /c/Users/me/AppData/Roaming/npm/claude --resume abc',
  creationTimeMs: BORN
}
const ORPHAN_CLAUDE = {
  pid: 15864,
  ppid: 5656,
  name: 'claude.exe',
  command:
    'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe --resume abc',
  creationTimeMs: BORN + 100
}
// Another pane's orphans, born before this pane under an earlier holder of DEAD_ROOT's pid.
const FOREIGN_SH = { ...ORPHAN_SH, pid: 9100, creationTimeMs: SPAWNED - 500 }
const FOREIGN_CLAUDE = { ...ORPHAN_CLAUDE, pid: 9101, ppid: 9100, creationTimeMs: BORN }

const fresh = { fresh: true, paneSpawnedAtMs: SPAWNED }

describe('resolveWindowsAgentForegroundProcessWithAvailability when the pane root has exited', () => {
  beforeEach(() => {
    tableRows.current = [ORPHAN_SH, ORPHAN_CLAUDE]
  })

  it('finds the agent the exited root left running', async () => {
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', {
        ...fresh,
        readWindowsConsoleAttachedProcessIds: async () => new Set([5656, 15864])
      })
    ).resolves.toMatchObject({ available: true, processName: 'claude', processId: 15864 })
  })

  it('stays unavailable without console evidence', async () => {
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', fresh)
    ).resolves.toEqual({ available: false, processName: null })
  })

  it('stays unavailable when the pane spawn time is unknown', async () => {
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', {
        fresh: true,
        readWindowsConsoleAttachedProcessIds: async () => new Set([5656, 15864])
      })
    ).resolves.toEqual({ available: false, processName: null })
  })

  it('stays unavailable when an orphan has no creation time', async () => {
    const { creationTimeMs: _unknown, ...undated } = ORPHAN_SH
    tableRows.current = [undated, ORPHAN_CLAUDE]
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', {
        ...fresh,
        readWindowsConsoleAttachedProcessIds: async () => new Set([5656, 15864])
      })
    ).resolves.toEqual({ available: false, processName: null })
  })

  it('stays unavailable when the orphans name two different agents', async () => {
    tableRows.current = [
      ORPHAN_SH,
      ORPHAN_CLAUDE,
      {
        pid: 8000,
        ppid: DEAD_ROOT,
        name: 'sh.exe',
        command: 'sh.exe -c codex',
        creationTimeMs: BORN
      },
      { pid: 8001, ppid: 8000, name: 'codex.exe', command: 'codex.exe', creationTimeMs: BORN }
    ]
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', {
        ...fresh,
        readWindowsConsoleAttachedProcessIds: async () => new Set([5656, 15864, 8000, 8001])
      })
    ).resolves.toEqual({ available: false, processName: null })
  })

  it("never credits another pane's orphan whose parent pid the dead root reused", async () => {
    tableRows.current = [FOREIGN_SH, FOREIGN_CLAUDE]
    const readConsole = vi.fn(async () => new Set([9100, 9101]))
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', {
        ...fresh,
        readWindowsConsoleAttachedProcessIds: readConsole
      })
    ).resolves.toEqual({ available: false, processName: null })
    expect(readConsole).not.toHaveBeenCalled()
  })

  it("reads through the pane's own orphan when an older one is listed too", async () => {
    tableRows.current = [ORPHAN_SH, ORPHAN_CLAUDE, FOREIGN_SH, FOREIGN_CLAUDE]
    const readConsole = vi.fn(async () => new Set([5656, 15864]))
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', {
        ...fresh,
        readWindowsConsoleAttachedProcessIds: readConsole
      })
    ).resolves.toMatchObject({ available: true, processName: 'claude' })
    expect(readConsole).toHaveBeenCalledWith(5656)
  })

  it('stays unavailable on a cached table, which may be stale', async () => {
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', {
        paneSpawnedAtMs: SPAWNED
      })
    ).resolves.toEqual({ available: false, processName: null })
  })

  it('never proves a shell from orphans that hold no agent', async () => {
    tableRows.current = [
      {
        pid: 7000,
        ppid: DEAD_ROOT,
        name: 'node.exe',
        command: 'node server.js',
        creationTimeMs: BORN
      }
    ]
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', fresh)
    ).resolves.toEqual({ available: false, processName: null })
  })

  it('stays unavailable when the root left no orphans', async () => {
    tableRows.current = []
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', fresh)
    ).resolves.toEqual({ available: false, processName: null })
  })

  it('stays unavailable when console membership cannot be read', async () => {
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', {
        ...fresh,
        readWindowsConsoleAttachedProcessIds: async () => null
      })
    ).resolves.toEqual({ available: false, processName: null })
  })

  it('does not report a shell when the console filter removes the only agent', async () => {
    // A plain shell orphan stays on this console; the agent below it has detached.
    tableRows.current = [{ ...ORPHAN_SH, command: 'sh.exe' }, ORPHAN_CLAUDE]
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', {
        ...fresh,
        readWindowsConsoleAttachedProcessIds: async () => new Set([5656])
      })
    ).resolves.toEqual({ available: false, processName: null })
  })

  it('never reads membership through an orphan that opened its own console', async () => {
    tableRows.current = [
      ORPHAN_SH,
      {
        pid: 6000,
        ppid: 5656,
        name: 'conhost.exe',
        command: 'conhost.exe 0x4',
        creationTimeMs: BORN
      },
      ORPHAN_CLAUDE
    ]
    const readConsole = vi.fn(async () => new Set([5656, 15864]))
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', {
        ...fresh,
        readWindowsConsoleAttachedProcessIds: readConsole
      })
    ).resolves.toEqual({ available: false, processName: null })
    expect(readConsole).not.toHaveBeenCalled()
  })

  it('reads membership through the orphan that kept the pane console', async () => {
    tableRows.current = [
      {
        pid: 7000,
        ppid: DEAD_ROOT,
        name: 'cmd.exe',
        command: 'cmd.exe /c start',
        creationTimeMs: BORN
      },
      {
        pid: 7001,
        ppid: 7000,
        name: 'conhost.exe',
        command: 'conhost.exe 0x4',
        creationTimeMs: BORN
      },
      ORPHAN_SH,
      ORPHAN_CLAUDE
    ]
    const readConsole = vi.fn(async () => new Set([5656, 15864]))
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', {
        ...fresh,
        readWindowsConsoleAttachedProcessIds: readConsole
      })
    ).resolves.toMatchObject({ available: true, processName: 'claude' })
    expect(readConsole).toHaveBeenCalledWith(5656)
  })

  it('keeps attaching through a live root', async () => {
    tableRows.current = [
      { pid: DEAD_ROOT, ppid: 1, name: 'bash.exe', command: 'bash.exe', creationTimeMs: SPAWNED },
      ORPHAN_SH,
      ORPHAN_CLAUDE
    ]
    const readConsole = vi.fn(async () => new Set([DEAD_ROOT, 5656, 15864]))
    await expect(
      resolveWindowsAgentForegroundProcessWithAvailability(DEAD_ROOT, 'bash.exe', {
        ...fresh,
        readWindowsConsoleAttachedProcessIds: readConsole
      })
    ).resolves.toMatchObject({ available: true, processName: 'claude' })
    expect(readConsole).toHaveBeenCalledWith(undefined)
  })
})
