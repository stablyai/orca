import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsResult
} from '../../shared/runtime-types'
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import { OrcaRuntimeService } from './orca-runtime'

const WT = 'repo-1::/tmp/worktree-a'

const terminal: RuntimeMobileSessionSnapshotTab = {
  type: 'terminal',
  id: 'term-1::leaf-1',
  parentTabId: 'term-1',
  leafId: 'leaf-1',
  title: 'Terminal',
  isActive: true
}
const file: RuntimeMobileSessionSnapshotTab = {
  type: 'file',
  id: 'file-1',
  filePath: '/tmp/worktree-a/notes.txt',
  relativePath: 'notes.txt',
  title: 'notes.txt',
  language: 'plaintext',
  isDirty: false,
  isActive: false
}

function createRuntime() {
  const runtime = new OrcaRuntimeService()
  const frames: RuntimeMobileSessionTabsResult[] = []
  runtime.onMobileSessionTabsChanged((frame) => frames.push(frame))
  const publishWindowTabs = (
    version: number,
    tabGroups: RuntimeMobileSessionTabGroup[],
    tabGroupLayout?: TabGroupLayoutNode
  ): void => {
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: WT,
          publicationEpoch: 'renderer:test',
          snapshotVersion: version,
          activeGroupId: 'group-1',
          activeTabId: terminal.id,
          activeTabType: 'terminal',
          tabGroups,
          ...(tabGroupLayout ? { tabGroupLayout } : {}),
          tabs: [file, terminal]
        }
      ]
    })
  }
  const restoreChat = (sessionId: string): void => {
    runtime.projectStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId,
      agent: 'claude',
      activate: false
    })
  }
  const latestFrame = (): RuntimeMobileSessionTabsResult | undefined => {
    vi.advanceTimersByTime(300)
    return frames.at(-1)
  }
  return { publishWindowTabs, restoreChat, latestFrame }
}

function group(id: string, tabOrder: string[]): RuntimeMobileSessionTabGroup {
  return { id, activeTabId: tabOrder[0] ?? null, tabOrder }
}

describe('mobile tab order for a window publication with chats', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends tabs in the window tab bar order, chats included', () => {
    const { publishWindowTabs, restoreChat, latestFrame } = createRuntime()
    publishWindowTabs(1, [group('group-1', ['file-1', 'term-1'])])
    // The chat opens after the terminal, so the runtime appends it to its own list.
    restoreChat('claude_a')
    // The user drags the chat to the front of the window's tab bar.
    publishWindowTabs(2, [group('group-1', ['agent-session:claude_a', 'file-1', 'term-1'])])

    const frame = latestFrame()
    expect(frame?.tabs.map((tab) => tab.id)).toEqual([
      'agent-session:claude_a',
      'file-1',
      terminal.id
    ])
    expect(frame?.tabGroups?.[0]?.tabOrder).toEqual(['agent-session:claude_a', 'file-1', 'term-1'])
  })

  it('keeps the place the window gave a chat it listed before main restored it', () => {
    const { publishWindowTabs, restoreChat, latestFrame } = createRuntime()
    publishWindowTabs(1, [group('group-1', ['file-1', 'term-1'])])
    restoreChat('claude_a')
    // A second chat sits in its own group on the left; the window lists it before main restores it.
    publishWindowTabs(
      2,
      [
        group('group-1', ['file-1', 'term-1', 'agent-session:claude_a']),
        group('group-2', ['agent-session:claude_b'])
      ],
      {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'group-2' },
        second: { type: 'leaf', groupId: 'group-1' }
      }
    )
    restoreChat('claude_b')

    const frame = latestFrame()
    expect(frame?.tabs.map((tab) => tab.id)).toEqual([
      'agent-session:claude_b',
      'file-1',
      terminal.id,
      'agent-session:claude_a'
    ])
    expect(frame?.tabGroups?.map((entry) => [entry.id, entry.tabOrder])).toEqual([
      ['group-1', ['file-1', 'term-1', 'agent-session:claude_a']],
      ['group-2', ['agent-session:claude_b']]
    ])
  })
})
