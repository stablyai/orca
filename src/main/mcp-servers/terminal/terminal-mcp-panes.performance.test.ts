// Guards STA-18285: each MCP terminal spawn queued its own rewrite of the whole pane file, so a burst
// of spawns behind a slow write replaced the same file once per spawn.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import type * as AtomicFileWrite from '../../plugins/installation/plugin-atomic-file-write'

const disk = vi.hoisted(() => ({ writes: 0, held: Promise.resolve() }))

vi.mock('../../plugins/installation/plugin-atomic-file-write', async (load) => {
  const real = await load<typeof AtomicFileWrite>()
  return {
    ...real,
    writePluginFileAtomically: async (
      ...args: Parameters<typeof real.writePluginFileAtomically>
    ) => {
      disk.writes += 1
      await disk.held
      return real.writePluginFileAtomically(...args)
    }
  }
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const pane = (index: number) => ({
  agent: 'claude',
  workspaceKey: null,
  workspaceId: `wt-${index}`,
  wsl: false,
  fingerprint: `fp-${index}`
})

// File replacements for `spawns` records that arrive while the first spawn's write is stuck.
async function writesForBurst(spawns: number): Promise<number> {
  const userData = mkdtempSync(join(tmpdir(), 'mcp-terminal-panes-'))
  dirs.push(userData)
  setAppEnvironment({
    getPath: () => userData,
    getAppPath: () => userData,
    getVersion: () => '0.0.0',
    isPackaged: () => true,
    getCliLauncherPath: () => null,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  vi.resetModules()
  const { terminalMcpPanes } = await import('./terminal-mcp-panes')
  let release = (): void => {}
  disk.held = new Promise((resolve) => (release = resolve))
  disk.writes = 0
  terminalMcpPanes.record('pty-first', pane(-1))
  await vi.waitFor(() => expect(disk.writes).toBe(1))
  for (let index = 0; index < spawns; index += 1) {
    terminalMcpPanes.record(`pty-${index}`, pane(index))
  }
  release()
  const file = join(userData, 'mcp-terminal-panes.json')
  const saved = (): Record<string, unknown> => {
    const written: { panes: Record<string, unknown> } = JSON.parse(readFileSync(file, 'utf8'))
    return written.panes
  }
  // Every record of the burst still reaches the file.
  await vi.waitFor(() => {
    expect(Object.keys(saved())).toHaveLength(Math.min(spawns + 1, 500))
    expect(saved()[`pty-${spawns - 1}`]).toEqual(pane(spawns - 1))
  })
  // A later spawn's write runs after every write queued before it, so the count is final then.
  terminalMcpPanes.record('pty-last', pane(spawns))
  await vi.waitFor(() => expect(saved()['pty-last']).toEqual(pane(spawns)))
  return disk.writes
}

it('replaces the pane file once for a burst of spawns behind a stuck write', async () => {
  // The stuck write, the burst's one write, and the later spawn's.
  expect(await writesForBurst(40)).toBe(3)
  expect(await writesForBurst(400)).toBe(3)
})
