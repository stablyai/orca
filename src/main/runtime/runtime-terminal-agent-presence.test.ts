import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalAgentStatusQuery } from './runtime-terminal-agent-status-query'
import {
  RuntimeTerminalAgentPresence,
  selectKeyboardAgentPresence
} from './runtime-terminal-agent-presence'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { OrcaRuntimeService } from './orca-runtime'
import { assertTerminalAgentSendable } from './rpc/terminal-agent-send-guard'
import type { AgentProcessPresence } from '../../shared/agent-process-presence'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

const CURSOR_APPROVAL = readFileSync(
  join(__dirname, '__fixtures__', 'cursor-agent-approval-prompt.txt'),
  'utf8'
)

function owner(agent: string, ended = false): AgentProcessPresence {
  return {
    agent,
    process: { pid: 42, platform: 'linux', startTime: 'boot:42' },
    ...(ended ? { ended: true as const } : {})
  }
}

function leaf(title: string): RuntimeLeafRecord {
  return {
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    leafId: 'leaf-1',
    paneRuntimeId: 1,
    ptyId: 'pty-1',
    paneTitle: title,
    ptyGeneration: 1,
    connected: true,
    writable: true,
    lastOutputAt: null,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastAgentStatusObservedLive: false,
    lastOscTitle: title,
    lastOscTitleAt: 1,
    paneTitleUpdatedAt: 1,
    tailBuffer: [],
    tailTranscriptBuffer: [],
    tailTranscriptChars: 0,
    tailPartialLine: '',
    tailPendingAnsi: '',
    tailRedrawCursor: null,
    tailTruncated: false,
    tailLinesTotal: 0,
    preview: '',
    waitBlockedAt: null
  }
}

function terminal(args: {
  presence: AgentProcessPresence | undefined
  title: string
  foreground: string | null | Error
  waitText?: string
  explicit?: 'working'
  titleStatus?: 'working'
}) {
  const readForeground = async () => {
    if (args.foreground instanceof Error) {
      throw args.foreground
    }
    return args.foreground
  }
  const presence = new RuntimeTerminalAgentPresence({
    getAgentPresence: () => args.presence,
    getLivePty: () => null,
    getLiveLeaf: () => leaf(args.title),
    getPrimaryLeaf: () => null,
    getTrackedPty: () => null,
    getTabTitle: () => null,
    getForegroundProcess: readForeground,
    getTitleDisplayClear: () => null
  })
  const controller: RuntimePtyController = {
    write: () => false,
    kill: () => false,
    getForegroundProcess: readForeground,
    confirmForegroundProcess: readForeground
  }
  const query = new RuntimeTerminalAgentStatusQuery({
    getAgentPresence: () => args.presence,
    getController: () => controller,
    getLivePty: () => null,
    getLiveLeaf: () => ({ leaf: leaf(args.title) }),
    getPrimaryLeaf: () => null,
    getTabTitle: () => args.title,
    getExplicitStatus: () =>
      args.explicit ? { status: args.explicit, updatedAt: Date.now() - 1000 } : null,
    getLifecycleStatus: () => null,
    isRunning: (handle) => presence.isRunning(handle),
    getTitleDisplayClear: () => null
  })
  vi.spyOn(query, 'getPtyId').mockReturnValue('pty-1')
  vi.spyOn(query, 'getSnapshot').mockReturnValue({
    waitText: args.waitText ?? '',
    waitBlockedAt: args.waitText ? Date.now() : null,
    title: args.title,
    titleStatus: args.titleStatus ?? null,
    titleStatusIsLive: true
  })
  return { presence, query }
}

describe('headless terminal presence', () => {
  it.each([false, true])('uses host presence under a shell title (ended=%s)', async (ended) => {
    const { presence, query } = terminal({
      presence: owner('claude', ended),
      title: 'zsh',
      foreground: 'claude',
      explicit: 'working'
    })
    expect(await presence.isRunning('terminal')).toBe(!ended)
    expect(await query.getStatus('terminal')).toEqual({
      handle: 'terminal',
      isRunningAgent: !ended,
      status: ended ? null : 'working'
    })
  })

  it('refuses to send into the shell in front of a suspended owner', async () => {
    // Ctrl-Z leaves the owner alive (the probe reads a stopped process as unverifiable).
    for (const explicit of ['working', undefined] as const) {
      const { presence, query } = terminal({
        presence: owner('claude'),
        title: 'user@host: ~/repo',
        foreground: 'bash',
        explicit
      })
      expect(await presence.isRunning('terminal')).toBe(false)
      expect(await query.getStatus('terminal')).toEqual({
        handle: 'terminal',
        isRunningAgent: false,
        status: null
      })
      const runtime: Pick<OrcaRuntimeService, 'getTerminalAgentStatus'> = {
        getTerminalAgentStatus: (handle) => query.getStatus(handle)
      }
      await expect(
        assertTerminalAgentSendable({
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard reads only getTerminalAgentStatus.
          runtime: runtime as OrcaRuntimeService,
          handle: 'terminal',
          assertWritable: () => {}
        })
      ).rejects.toThrow('terminal_guard_no_agent')
    }
  })

  it('keeps the approval-menu permission ahead of an identified owner', async () => {
    // Cursor reports its approval gate as working; only the screen shows the menu.
    const { query } = terminal({
      presence: owner('cursor'),
      title: 'Cursor Agent',
      foreground: 'cursor-agent',
      waitText: CURSOR_APPROVAL,
      explicit: 'working'
    })
    expect(await query.getStatus('terminal')).toEqual({
      handle: 'terminal',
      isRunningAgent: true,
      status: 'permission'
    })
  })

  it('keeps the management screen from reading as a task agent for an identified owner', async () => {
    const { presence, query } = terminal({
      presence: owner('claude'),
      title: 'claude agents',
      foreground: 'claude',
      explicit: 'working'
    })
    expect(await presence.isRunning('terminal')).toBe(false)
    expect(await query.getStatus('terminal')).toEqual({
      handle: 'terminal',
      isRunningAgent: false,
      status: null
    })
  })

  it('shows a hookless agent started after the owner exited, as it would without presence', async () => {
    for (const presence of [owner('claude', true), undefined]) {
      const { presence: running, query } = terminal({
        presence,
        title: 'aider',
        foreground: 'aider'
      })
      expect(await running.isRunning('terminal')).toBe(true)
      expect(await query.getStatus('terminal')).toMatchObject({ isRunningAgent: true })
    }
  })

  it('does not revive an exited owner from its own title or foreground process', async () => {
    const evidence = {
      title: '✳ Claude Code',
      foreground: 'claude',
      titleStatus: 'working'
    } as const
    const exited = terminal({ presence: owner('claude', true), ...evidence })
    expect(await exited.presence.isRunning('terminal')).toBe(false)
    expect(await exited.query.getStatus('terminal')).toEqual({
      handle: 'terminal',
      isRunningAgent: false,
      status: null
    })
    // The same evidence without presence reads as a running Claude.
    const legacy = terminal({ presence: undefined, ...evidence })
    expect(await legacy.presence.isRunning('terminal')).toBe(true)
  })

  it('keeps main rules for a live owner recorded on another host (WSL guest, SSH)', async () => {
    const row = (connectionId: string | null): AgentStatusIpcPayload => ({
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId,
      state: 'done',
      prompt: '',
      receivedAt: 10,
      stateStartedAt: 10,
      agentType: 'claude',
      agentPresence: owner('claude')
    })
    const remoteOwner = selectKeyboardAgentPresence([row('wsl:Ubuntu')])
    for (const [title, running] of [
      ['user@host: ~/repo', false],
      ['✳ Claude Code', true]
    ] as const) {
      const remote = terminal({ presence: remoteOwner, title, foreground: 'wsl.exe' })
      const main = terminal({ presence: undefined, title, foreground: 'wsl.exe' })
      expect(await remote.presence.isRunning('terminal')).toBe(running)
      expect(await main.presence.isRunning('terminal')).toBe(running)
      expect(await remote.query.getStatus('terminal')).toEqual(
        await main.query.getStatus('terminal')
      )
    }
  })
})

async function settle<T>(work: Promise<T>): Promise<T> {
  const done = work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
  await vi.runAllTimersAsync()
  const result = await done
  if ('error' in result) {
    throw result.error
  }
  return result.value
}

async function sendGuardAnswer(query: RuntimeTerminalAgentStatusQuery): Promise<string> {
  const runtime: Pick<OrcaRuntimeService, 'getTerminalAgentStatus'> = {
    getTerminalAgentStatus: (handle) => query.getStatus(handle)
  }
  try {
    await settle(
      assertTerminalAgentSendable({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard reads only getTerminalAgentStatus.
        runtime: runtime as OrcaRuntimeService,
        handle: 'terminal',
        assertWritable: () => {}
      })
    )
    return 'sends'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('keyboard routing for a live owner that is not in front', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // After Ctrl-Z the owner stays live (a stopped process reads as unverifiable), so only the
  // program in front may decide; every row must answer exactly as it does without presence.
  it.each([
    ['ssh', 'user@prod: ~', undefined],
    ['vim', 'vim notes.md', undefined],
    ['python3', 'python3', undefined],
    ['less', 'git log', undefined],
    ['tmux', 'tmux', undefined],
    ['bash', 'user@host: ~/repo', undefined],
    [null, 'user@host: ~/repo', undefined],
    [new Error('foreground read failed'), 'user@host: ~/repo', undefined],
    ['vim', 'zsh', 'working']
  ] as const)(
    'matches main with %s in front (title %s, hook %s)',
    async (foreground, title, explicit) => {
      const withOwner = terminal({ presence: owner('claude'), title, foreground, explicit })
      const main = terminal({ presence: undefined, title, foreground, explicit })
      const mainRunning = await settle(main.presence.isRunning('terminal'))
      expect(mainRunning).toBe(false)
      expect(await settle(withOwner.presence.isRunning('terminal'))).toBe(mainRunning)
      expect(await settle(withOwner.query.getStatus('terminal'))).toEqual(
        await settle(main.query.getStatus('terminal'))
      )
      expect(await sendGuardAnswer(withOwner.query)).toBe('terminal_guard_no_agent')
      expect(await sendGuardAnswer(main.query)).toBe('terminal_guard_no_agent')
    }
  )

  it('keeps the owner under a shell title when the owner itself is in front', async () => {
    const withOwner = terminal({
      presence: owner('claude'),
      title: 'zsh',
      foreground: 'claude',
      explicit: 'working'
    })
    expect(await settle(withOwner.query.getStatus('terminal'))).toEqual({
      handle: 'terminal',
      isRunningAgent: true,
      status: 'working'
    })
    expect(await sendGuardAnswer(withOwner.query)).toBe('sends')
  })
})
