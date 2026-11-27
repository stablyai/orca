// Guards STA-18284: the stale-terminal count read the host list, and opened every saved value with it,
// once per agent terminal it compared.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { changeBotToolEntries } from '../../bots/bot-tools-file'
import type * as BotToolsFile from '../../bots/bot-tools-file'
import { currentTerminalMcpFingerprints } from './terminal-mcp-launch'

const reads = vi.hoisted(() => ({ count: 0 }))

vi.mock('../../bots/bot-tools-file', async (load) => {
  const real = await load<typeof BotToolsFile>()
  return {
    ...real,
    readBotToolsSnapshot: (folder: string) => {
      reads.count += 1
      return real.readBotToolsSnapshot(folder)
    }
  }
})

const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
const relay = { grant: async () => ({ origin: 'http://127.0.0.1:4100', token: 'relay-token' }) }

beforeEach(() => {
  process.env.ORCA_MCP_SERVERS = '1'
  const userData = tempDir('mcp-terminal-user-data-')
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
})
afterEach(() => {
  delete process.env.ORCA_MCP_SERVERS
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Host-list reads for one count over `panes` terminals, each in its own workspace.
async function readsForCount(panes: number): Promise<number> {
  const hostFolder = tempDir('mcp-host-list-')
  await changeBotToolEntries(hostFolder, () => [
    {
      server: { name: 'keyed', url: 'https://keyed.example.test/mcp', credential: 'cred-keyed-1' },
      extras: { id: 'id-keyed-0001' }
    },
    { server: { name: 'plain', url: 'https://plain.example.test/mcp' }, extras: { id: 'id-plain' } }
  ])
  const launches = Array.from({ length: panes }, (_, index) => ({
    agent: 'claude',
    workspaceId: `wt-${index}`,
    wsl: false
  }))
  reads.count = 0
  const fingerprints = await currentTerminalMcpFingerprints(launches, { relay, hostFolder })
  expect([...fingerprints.values()].every((fingerprint) => fingerprint !== null)).toBe(true)
  return reads.count
}

it('reads the host list once per count, however many terminals it compares', async () => {
  expect(await readsForCount(50)).toBe(1)
  expect(await readsForCount(500)).toBe(1)
})
