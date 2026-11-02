import { describe, expect, it, vi } from 'vitest'
import {
  ClaudeTerminalSessionNameSync,
  type ClaudeTerminalSessionNameSyncDeps
} from './claude-terminal-session-name-sync'
import {
  claudeTitleShowsName,
  latestClaudeCustomTitle
} from '../claude/claude-terminal-session-name'

const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'
const PANE = `tab-1:${LEAF}`

function harness(overrides: Partial<ClaudeTerminalSessionNameSyncDeps> = {}) {
  let customTitle: string | null = null
  const sent: string[] = []
  const renamed: string[] = []
  let sync: ClaudeTerminalSessionNameSync
  const deps: ClaudeTerminalSessionNameSyncDeps = {
    isEnabled: () => true,
    listRows: () => [{ paneKey: PANE, agentType: 'claude' }],
    readTranscriptPath: () => '/t.jsonl',
    getHandle: () => 'handle-1',
    waitForEmptyComposer: async () => true,
    sendCommand: async (_handle, text) => {
      sent.push(text)
      // Claude records the rename, then retitles its window.
      customTitle = text.replace('/rename ', '')
      sync.observeTitle(PANE, customTitle)
    },
    renameTab: async (_handle, name) => {
      renamed.push(name)
      // The host's renameTerminal reports the rename back, as it does for every source.
      sync.tabRenamed('tab-1', name)
    },
    readCustomTitle: async () => customTitle,
    ...overrides
  }
  sync = new ClaudeTerminalSessionNameSync(deps)
  return {
    sync,
    sent,
    renamed,
    claudeRenames: (name: string) => {
      customTitle = name
      sync.observeTitle(PANE, name)
    }
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('ClaudeTerminalSessionNameSync', () => {
  it('sends /rename for a tab rename without renaming the tab back', async () => {
    const { sync, sent, renamed } = harness()
    sync.tabRenamed('tab-1', '  fix   login ')
    await settle()
    sync.tabRenamed('tab-1', 'fix login')
    await settle()
    expect(sent).toEqual(['/rename fix login'])
    expect(renamed).toEqual([])
  })

  it('names the tab after a /rename typed in Claude, without sending it back', async () => {
    const { claudeRenames, sent, renamed } = harness()
    claudeRenames('payments refactor')
    await settle()
    expect(renamed).toEqual(['payments refactor'])
    expect(sent).toEqual([])
  })

  it('ignores Claude titles its transcript never recorded as a rename', async () => {
    const { sync, renamed } = harness({ readCustomTitle: async () => 'older name' })
    sync.observeTitle(PANE, 'Login bug')
    await settle()
    expect(renamed).toEqual([])
  })

  it('confirms a title at the next turn change once the transcript catches up', async () => {
    let recorded: string | null = null
    const { sync, renamed } = harness({ readCustomTitle: async () => recorded })
    sync.observeTitle(PANE, 'early name')
    await settle()
    expect(renamed).toEqual([])
    recorded = 'early name'
    sync.observeTurnChange(PANE)
    await settle()
    expect(renamed).toEqual(['early name'])
  })

  it('leaves a tab with several Claude panes alone', async () => {
    const { sync, sent } = harness({
      listRows: () => [
        { paneKey: PANE, agentType: 'claude' },
        { paneKey: `tab-1:${OTHER_LEAF}`, agentType: 'claude' }
      ]
    })
    sync.tabRenamed('tab-1', 'shared')
    await settle()
    expect(sent).toEqual([])
  })

  it('sends only the newest name once the composer frees up', async () => {
    const waits: (() => void)[] = []
    const sendCommand = vi.fn(async () => {})
    const { sync } = harness({
      sendCommand,
      waitForEmptyComposer: (_handle, signal) =>
        new Promise((resolve) => {
          waits.push(() => resolve(!signal.aborted))
        })
    })
    sync.tabRenamed('tab-1', 'first')
    sync.tabRenamed('tab-1', 'second')
    for (const release of waits) {
      release()
    }
    await settle()
    expect(sendCommand).toHaveBeenCalledTimes(1)
    expect(sendCommand).toHaveBeenCalledWith('handle-1', '/rename second', expect.anything())
  })
  it('lets a /rename typed in Claude win over a tab rename still waiting for the composer', async () => {
    const sendCommand = vi.fn(async () => {})
    const { sync, claudeRenames, renamed } = harness({
      sendCommand,
      waitForEmptyComposer: (_handle, signal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve(false)))
    })
    sync.tabRenamed('tab-1', 'from orca')
    claudeRenames('from claude')
    await settle()
    expect(renamed).toEqual(['from claude'])
    expect(sendCommand).not.toHaveBeenCalled()
  })

  it('reads the transcript once per shown name, not per spinner frame', async () => {
    const readCustomTitle = vi.fn(async () => 'spun')
    const { sync, renamed } = harness({ readCustomTitle })
    for (const frame of ['⠂ spun', '⠐ spun', '✳ spun']) {
      sync.observeTitle(PANE, frame)
    }
    await settle()
    expect(readCustomTitle).toHaveBeenCalledTimes(1)
    expect(renamed).toEqual(['spun'])
  })

  it('retries a name whose /rename was not delivered', async () => {
    const sendCommand = vi
      .fn<ClaudeTerminalSessionNameSyncDeps['sendCommand']>()
      .mockRejectedValueOnce(new Error('agent_not_in_foreground'))
      .mockResolvedValue(undefined)
    const { sync } = harness({ sendCommand })
    sync.tabRenamed('tab-1', 'again')
    await settle()
    sync.tabRenamed('tab-1', 'again')
    await settle()
    expect(sendCommand).toHaveBeenCalledTimes(2)
  })

  it('does not name a tab with several Claude panes from one of them', async () => {
    const { claudeRenames, renamed } = harness({
      listRows: () => [
        { paneKey: PANE, agentType: 'claude' },
        { paneKey: `tab-1:${OTHER_LEAF}`, agentType: 'claude' }
      ]
    })
    claudeRenames('one of two')
    await settle()
    expect(renamed).toEqual([])
  })

  it('withdraws a rename still waiting for the composer when the tab title is cleared', async () => {
    const sendCommand = vi.fn(async () => {})
    let release: (() => void) | undefined
    const { sync } = harness({
      sendCommand,
      waitForEmptyComposer: (_handle, signal) =>
        new Promise((resolve) => {
          release = () => resolve(!signal.aborted)
        })
    })
    sync.tabRenamed('tab-1', 'never mind')
    sync.tabRenamed('tab-1', null)
    release?.()
    await settle()
    expect(sendCommand).not.toHaveBeenCalled()
  })
})

describe('Claude transcript names', () => {
  it('reads the newest custom title and skips a torn last line', () => {
    const tail = [
      '{"type":"custom-title","customTitle":"old","sessionId":"s"}',
      '{"type":"user","message":"custom-title in prose"}',
      '{"type":"custom-title","customTitle":"new","sessionId":"s"}',
      '{"type":"custom-title","customTi'
    ].join('\n')
    expect(latestClaudeCustomTitle(tail)).toBe('new')
  })

  it('matches a title with or without the status glyph', () => {
    expect(claudeTitleShowsName('my name', 'my name')).toBe(true)
    expect(claudeTitleShowsName('✳ my name', 'my name')).toBe(true)
    expect(claudeTitleShowsName('not my name', 'my name')).toBe(false)
  })
})
