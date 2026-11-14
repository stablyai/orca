import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createDatabase,
  createRuntime,
  createBoundRun,
  insertDirectRunMessage,
  PTY_ID,
  PANE_KEY,
  TAB_ID,
  WORKTREE_ID,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { readRuntimeFixture } from '../../../terminal/wait/agent-transcript-replay-test-harness'
import { readMailboxForeground } from '../../../terminal/wait/launched-agent-foreground'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

function ready(agent: 'claude' | 'codex') {
  return `\x1b[2J\x1b[H${readRuntimeFixture(
    agent === 'claude' ? 'claude-2-1-316-default-unlabelled-empty' : 'codex-0157-plain-ready'
  )}`
}
function composer(agent: 'claude' | 'codex', text: string) {
  return agent === 'claude'
    ? `\x1b[2J\x1b[H${'─'.repeat(100)}\r\n❯ ${text.trim()}\r\n${'─'.repeat(100)}\r\n  auto mode on\x1b[2;3H`
    : `\x1b[2J\x1b[HOpenAI Codex\r\n${'─'.repeat(100)}\r\n\x1b[1m›\x1b[0m ${text.trim()}\r\n\r\n\x1b[2mgpt-6.1 · ~/repo\r\n? for shortcuts\x1b[0m\x1b[3;3H\x1b[?25h`
}
function observation(process: string) {
  return {
    foregroundProcess: process,
    hasChildProcesses: process !== 'zsh',
    foregroundObservation: {
      ptyId: PTY_ID,
      ptyIncarnationId: 'mailbox-incarnation',
      authorityGeneration: 'synthetic-host',
      observationEpoch: 1,
      capturedAgeMs: 0,
      verdict: 'observed' as const,
      source: 'pty-master' as const,
      foregroundKind: process === 'zsh' ? ('shell' as const) : ('non-shell' as const),
      processName: process
    }
  }
}

const originalPlatform = process.platform
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each([
  { agent: 'claude', identity: 'missing', process: 'claude', confirmed: 'claude' },
  { agent: 'codex', identity: 'missing', process: 'codex', confirmed: 'codex' },
  { agent: 'claude', identity: 'removed', process: '2.1.323', confirmed: 'claude' },
  {
    agent: 'codex',
    identity: 'removed',
    process: 'node',
    confirmed: 'node /opt/node_modules/@openai/codex/bin/codex.js'
  },
  {
    agent: 'claude',
    identity: 'removed',
    process: 'node',
    confirmed: 'node /opt/node_modules/@anthropic-ai/claude-code/cli.js'
  }
] as const)(
  'delivers once after a silent long hold with $identity $agent identity ($process)',
  async ({ agent, identity, process, confirmed }) => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mail-foreground-identity-')
    let rows: AgentStatusIpcPayload[] =
      identity === 'removed'
        ? [
            {
              paneKey: PANE_KEY,
              tabId: TAB_ID,
              worktreeId: WORKTREE_ID,
              connectionId: null,
              agentType: agent,
              state: 'done',
              prompt: '',
              receivedAt: Date.now(),
              stateStartedAt: 1
            }
          ]
        : []
    const { runtime, write } = createRuntime(db, {
      launchAgent: null,
      getAgentStatusSnapshot: () => rows,
      getAgentStatusSnapshotForPane: () => rows
    })
    let front = 'zsh'
    let verified = false
    runtime.setPtyController({
      write,
      kill: vi.fn(),
      getSize: () => ({ cols: 120, rows: 40 }),
      getForegroundProcess: async () => (identity === 'missing' ? 'zsh' : front),
      confirmForegroundProcess: async () => (verified && front === process ? confirmed : front),
      supportsForegroundObservation: () => true,
      inspectProcess: async () => observation(front),
      writeWithSettlement: (ptyId, text) => {
        write(ptyId, text)
        runtime.onPtyData(PTY_ID, text === '\r' ? ready(agent) : composer(agent, text), Date.now())
        return { outcome: 'accepted' }
      }
    })
    try {
      await runtime.listTerminals()
      runtime.onPtyData(PTY_ID, `\x1b]0;${agent} done\x07${ready(agent)}`, Date.now())
      runtime.onPtyData(PTY_ID, '\x1b]0;/tmp/title-setting-shell\x07', Date.now())
      const run = createBoundRun(db, 'Identity-free silent return')
      const message = insertDirectRunMessage(db, run.id, 'Resume without a user turn')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      expect(await runtime.readTerminalMailHold(`run:${run.id}`)).toMatchObject({
        kind: 'not-foreground'
      })
      rows = []
      await vi.advanceTimersByTimeAsync(35 * 60 * 1000)
      expect(write).not.toHaveBeenCalled()
      expect(db.getMessageById(message.id)).toMatchObject({
        read: 0,
        delivered_at: null,
        pointer_enter_pending: 0
      })
      for (const program of ['vim', 'less', 'ssh', 'node', 'vim /tmp/claude']) {
        front = program
        await vi.advanceTimersByTimeAsync(65000)
        expect(write).not.toHaveBeenCalled()
      }
      verified = true
      front = process
      // Recorded empty composer; the shell title is retained, with no agent turn or hook refresh.
      runtime.onPtyData(PTY_ID, ready(agent), Date.now())
      await vi.advanceTimersByTimeAsync(125000)
      expect(write.mock.calls.map(([, text]) => text)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
      expect(db.getMessageById(message.id)).toMatchObject({
        read: 0,
        delivered_at: expect.any(String),
        pointer_enter_pending: 0
      })
      await vi.advanceTimersByTimeAsync(125000)
      expect(write).toHaveBeenCalledTimes(2)
      const later = insertDirectRunMessage(db, run.id, 'Later mail needs no retained identity')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(125000)
      expect(write.mock.calls.slice(2).map(([, text]) => text)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
      expect(db.getMessageById(later.id)).toMatchObject({
        read: 0,
        delivered_at: expect.any(String),
        pointer_enter_pending: 0
      })
    } finally {
      db.close()
    }
  }
)

it.each([
  'before staging',
  'after staging',
  'identity appears during probe',
  'target replaced during probe'
] as const)('preserves the intended agent and target %s', async (change) => {
  vi.useFakeTimers()
  const db = createDatabase('orca-mail-identity-fence-')
  let rows: AgentStatusIpcPayload[] = []
  const { runtime, write } = createRuntime(db, {
    launchAgent: change === 'before staging' ? 'claude' : null,
    getAgentStatusSnapshot: () => rows,
    getAgentStatusSnapshotForPane: () => rows
  })
  let front = 'zsh'
  let pause = false
  let release: (() => void) | undefined
  runtime.setPtyController({
    write,
    kill: vi.fn(),
    getSize: () => ({ cols: 100, rows: 30 }),
    getForegroundProcess: async () => front,
    supportsForegroundObservation: () => true,
    inspectProcess: async () => {
      const sampled = observation(front)
      if (pause) {
        pause = false
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return sampled
    },
    writeWithSettlement: (ptyId, text) => {
      write(ptyId, text)
      if (text !== '\r') {
        runtime.onPtyData(PTY_ID, composer('claude', text), Date.now())
        if (change === 'after staging') {
          front = 'codex'
        }
      }
      return { outcome: 'accepted' }
    }
  })
  try {
    await runtime.listTerminals()
    runtime.onPtyData(PTY_ID, `\x1b]0;Claude done\x07${ready('claude')}`, Date.now())
    runtime.onPtyData(PTY_ID, '\x1b]0;/tmp/title-setting-shell\x07', Date.now())
    const run = createBoundRun(db, 'Known recipient fence')
    const message = insertDirectRunMessage(db, run.id, 'Keep the intended agent')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    expect(await runtime.readTerminalMailHold(`run:${run.id}`)).toMatchObject({
      kind: 'not-foreground'
    })
    await vi.advanceTimersByTimeAsync(1000)
    front = change === 'before staging' ? 'codex' : 'claude'
    if (change.includes('during probe')) {
      pause = true
      const receipt = runtime.readTerminalMailHold(`run:${run.id}`)
      await vi.advanceTimersByTimeAsync(0)
      expect(release).toEqual(expect.any(Function))
      if (change === 'identity appears during probe') {
        rows = [
          {
            paneKey: PANE_KEY,
            connectionId: null,
            agentType: 'codex',
            state: 'done',
            prompt: '',
            receivedAt: Date.now(),
            stateStartedAt: 1
          }
        ]
      } else {
        await runtime.onPtyExit(PTY_ID, 0, 'mailbox-incarnation', { providerExitObserved: true })
      }
      release?.()
      await receipt
    }
    await vi.advanceTimersByTimeAsync(125000)
    expect(write.mock.calls.filter(([, text]) => text === '\r')).toEqual([])
    expect(write.mock.calls.filter(([, text]) => text !== '\r')).toHaveLength(
      change === 'after staging' ? 1 : 0
    )
    expect(db.getMessageById(message.id)).toMatchObject({ read: 0, delivered_at: null })
    if (change === 'before staging' || change === 'after staging') {
      front = 'claude'
      await vi.advanceTimersByTimeAsync(125000)
      expect(write.mock.calls.map(([, text]) => text)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
    }
  } finally {
    release?.()
    db.close()
  }
})

it.each([
  { remote: false, windows: true },
  { remote: true, windows: true },
  { remote: true, windows: false }
])('leaves unsupported foreground hosts unknown ($remote)', async (host) => {
  const result = await readMailboxForeground(
    {
      getForegroundProcess: async () => 'claude',
      confirmForegroundProcess: async () => 'claude',
      supportsForegroundObservation: () => false,
      inspectProcess: async () => observation('claude')
    },
    host,
    PTY_ID,
    undefined,
    'mailbox-incarnation'
  )
  expect(result).toEqual({ foreground: 'unknown' })
})
