import { expect, it } from 'vitest'
import type {
  LayoutTab,
  WorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-model'
import { restoredSwitchPlan } from './restored-switch-plan'

const terminal = (id: string, leaves: string[] = [`${id}-leaf`]): LayoutTab => ({
  id,
  entityId: id,
  kind: 'terminal',
  createdAt: 1,
  customTitle: null,
  color: null,
  terminal: { defaultTitle: id },
  panes: {
    root:
      leaves.length === 1
        ? { type: 'leaf', leafId: leaves[0]! }
        : {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: leaves[0]! },
            second: { type: 'leaf', leafId: leaves[1]! }
          }
  }
})

// One cold load: only a recorded tab still holding just a terminal no process holds takes its
// chat; a live, unknown or split terminal, or another chat, keeps its tab and the chat's record
// moves to a free one. A chat already shown, and every tab no record names, stay as they are.
it('replaces only a stopped terminal a chat record names, and moves the rest to free tabs', () => {
  const tabs = [
    terminal('crashed'),
    terminal('unbound'),
    terminal('live'),
    terminal('unknown'),
    terminal('split', ['split-a', 'split-b']),
    { ...terminal('chat-elsewhere'), kind: 'agent-session', entityId: 'other' } as LayoutTab,
    { ...terminal('shown-chat'), kind: 'agent-session', entityId: 'S-shown' } as LayoutTab,
    terminal('structured-agent-session-S-live'),
    terminal('ordinary')
  ]
  const workspace = {
    worktreeId: 'wt',
    tabs,
    groups: [{ id: 'g', tabOrder: tabs.map((tab) => tab.id) }],
    leaves: {
      'crashed-leaf': { ptyId: 'pty-dead' },
      'live-leaf': { ptyId: 'pty-live' },
      'unknown-leaf': { ptyId: 'pty-unknown' }
    }
  } as unknown as WorkspaceLayout
  const liveness = (ptyId: string) =>
    ({ 'pty-dead': false, 'pty-live': true })[ptyId] ?? (null as boolean | null)
  const chat = (sessionId: string, tabId: string) => ({ sessionId, agent: 'codex' as const, tabId })
  expect(
    restoredSwitchPlan(
      workspace,
      [
        chat('S-crashed', 'crashed'),
        chat('S-unbound', 'unbound'),
        chat('S-live', 'live'),
        chat('S-unknown', 'unknown'),
        chat('S-split', 'split'),
        chat('S-other', 'chat-elsewhere'),
        chat('S-shown', 'live'),
        chat('S-missing', 'nowhere')
      ],
      liveness
    )
  ).toEqual({
    replace: [
      { sessionId: 'S-crashed', agent: 'codex', tabId: 'crashed', terminalId: 'crashed' },
      { sessionId: 'S-unbound', agent: 'codex', tabId: 'unbound', terminalId: 'unbound' }
    ],
    move: [
      // Its usual id is taken by a terminal: the next free one.
      { sessionId: 'S-live', tabId: 'structured-agent-session-S-live-2' },
      { sessionId: 'S-unknown', tabId: 'structured-agent-session-S-unknown' },
      { sessionId: 'S-split', tabId: 'structured-agent-session-S-split' },
      { sessionId: 'S-other', tabId: 'structured-agent-session-S-other' }
    ]
  })
  // A load with no chat records changes nothing.
  expect(restoredSwitchPlan(workspace, [], liveness)).toEqual({ replace: [], move: [] })
})
