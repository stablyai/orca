import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { isWslUserActFor } from '../../wsl/discovery/wsl-user-act-scope'
import type { RpcContext } from '../rpc/core'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'

const rig = vi.hoisted(
  (): { file: string; starts: string[][]; source: ReturnType<typeof vi.fn> } => ({
    file: '',
    starts: [],
    source: vi.fn()
  })
)
vi.mock('../../agent-hooks/server/agent-hook-server', () => ({
  agentHookServer: {
    terminalAgentTranscriptSource: rig.source,
    terminalAgentPlaces: async () => [],
    sleepingTerminalAgent: async () => ({ record }),
    sleepingTerminalAgentIds: async () => [ID]
  }
}))
vi.mock('../../wsl/discovery/wsl-background-distro-gate', () => ({
  readWslDistroRunningState: async () => 'stopped',
  noteWslDistroWoken: () => {}
}))
vi.mock('../../wsl/execution/wsl-exe-process', () => ({
  runWslExe: async (args: string[]) => {
    expect(isWslUserActFor('Ubuntu')).toBe(true)
    expect(isWslUserActFor('Debian')).toBe(false)
    rig.starts.push(args)
    return ''
  }
}))
vi.mock('node:fs/promises', async (load) => {
  const fs = await load<typeof FsPromises>()
  const local = (path: Parameters<typeof fs.open>[0]) => {
    if (typeof path === 'string' && path.startsWith('\\\\wsl.localhost')) {
      expect(isWslUserActFor('Ubuntu')).toBe(true)
      return rig.file
    }
    return path
  }
  return {
    ...fs,
    open: (path: Parameters<typeof fs.open>[0], ...args: [string]) => fs.open(local(path), ...args),
    stat: (path: Parameters<typeof fs.stat>[0], options?: { bigint?: boolean }) =>
      fs.stat(local(path), options)
  }
})
vi.mock('../../native-chat/transcript-filesystem/wsl-transcript-fs-access', async (load) => {
  const actual = await load<Record<string, unknown>>()
  const fs = await import('node:fs/promises')
  const admitted = () => {
    expect(isWslUserActFor('Ubuntu')).toBe(true)
    expect(isWslUserActFor('Debian')).toBe(false)
    return rig.file
  }
  return {
    ...actual,
    wslGatedAccess: async () => {
      await fs.access(admitted())
      return true
    },
    transcriptFileStat: async () => fs.stat(admitted()),
    openTranscriptFile: async () => fs.open(admitted(), 'r'),
    readTranscriptFile: async (
      handle: Awaited<ReturnType<typeof fs.open>>,
      _path: string,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number
    ) => handle.read(buffer, offset, length, position),
    closeTranscriptHandle: async (handle: Awaited<ReturnType<typeof fs.open>>) => handle.close()
  }
})

import { readAgentConversation } from './agent-conversation-read'
import { listAgentConversations, showAgentConversation } from './agent-conversation-list'
const ID = testOrcaSessionId('claude_5688af50_12a0_4b0b_9a4a_098d87fe1e68')
const record = {
  paneKey: 'tab-a:11111111-1111-4111-8111-111111111111',
  tabId: 'tab-a',
  worktreeId: 'repo::/w',
  agent: 'claude' as const,
  providerSession: { key: 'session_id' as const, id: 'p', transcriptPath: '/home/u/p.jsonl' },
  wslDistro: 'Ubuntu',
  connectionId: null,
  prompt: '',
  state: 'done' as const,
  capturedAt: 1,
  updatedAt: 1,
  origin: 'worktree-sleep' as const
}
afterEach(() => {
  rig.starts.length = 0
})
it('lists and shows passively, then reads the real transcript through only its stopped attested distro', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-wsl-read-'))
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  rig.file = join(dir, 'p.jsonl')
  writeFileSync(
    rig.file,
    `${JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      sessionId: 'p',
      timestamp: '2026-11-14T12:00:00.000Z',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'MANGO' }] }
    })}\n`
  )
  const source = {
    key: {
      executionHost: 'local',
      wslDistro: 'Ubuntu',
      agent: 'claude',
      providerSessionId: 'p',
      locator: ''
    },
    providerSession: record.providerSession
  }
  rig.source.mockResolvedValue(source)
  const runtime = {
    readLocalSleepingAgentSessions: () => ({ [record.paneKey]: record }),
    getWorkspaceLabel: () => ({ workspace: 'main', repo: 'repo' }),
    orchestrationSenderNames: { agentRowNamer: () => () => 'Mango task' },
    getWorktreePs: async () => ({ worktrees: [], truncated: false, totalCount: 0 })
  }
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    expect((await listAgentConversations(runtime, 10)).agents).toHaveLength(1)
    expect(
      (await showAgentConversation(runtime, { kind: 'terminal', orcaSessionId: ID })).places
    ).toHaveLength(1)
    expect(rig.starts).toEqual([])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminal reads only use the runtime's saved records.
    const ctx = { runtime } as unknown as RpcContext
    expect(
      await readAgentConversation(ctx, { kind: 'terminal', orcaSessionId: ID }, {})
    ).toMatchObject({ entries: [{ role: 'assistant', text: 'MANGO' }] })
    expect(rig.starts).toEqual([['-d', 'Ubuntu', '--exec', 'true']])
    expect(isWslUserActFor('Ubuntu')).toBe(false)
    expect(rig.source).toHaveBeenCalledTimes(2)
  } finally {
    Object.defineProperty(process, 'platform', platform)
    rmSync(dir, { recursive: true, force: true })
  }
})
