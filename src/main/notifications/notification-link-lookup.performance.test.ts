// Perf contract (#45503, STA-16839): every structured chat notification rebuilt host worktree
// projections and reparsed external conversation links, even before skip gates or after sort-stamp writes.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultNotificationSettings } from '../../shared/notifications/notification-settings-defaults'
import type { NotificationDispatchRequest } from '../../shared/notifications/notification-settings-types'
import { removeTempDirs } from '../../shared/testing/remove-temp-dirs.test-support'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import {
  chatMailPlace,
  sessionRepliesInSlack,
  writeLink
} from '../external-conversations/external-conversation-links'
import {
  closeTestStores,
  createStore,
  makeRepo,
  testState
} from '../persistence/persistence-test-harness'
import { createStructuredAttentionMobileDelivery } from '../runtime/agent-session/lifecycle/structured-agent-session-mobile-attention'
import { createNotificationDeliveryService } from './notification-delivery-service'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const SLACK_SESSION = 'session-slack'
const LOCAL_SESSION = 'session-local'
const SLACK_REPLY = 'Pinged <!here> and <@U12345ABC|sam>.'
const CODE_REPLY = 'Updated Array<string> and <div> layout.'

const dirs: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await closeTestStores()
  await removeTempDirs(dirs.splice(0))
})

function buildFleet(worktreesPerHost: number) {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-notif-links-perf-'))
  dirs.push(testState.dir)
  const store = createStore()
  store.addRepo(makeRepo({ id: 'repo-local', path: '/fleet/local' }))
  store.addRepo(makeRepo({ id: 'repo-ssh', path: '/fleet/ssh', connectionId: 'conn-1' }))
  for (let index = 0; index < worktreesPerHost; index += 1) {
    store.setWorktreeMeta(
      hostWorktreeTarget({ id: `repo-local::/fleet/local/wt-${index}`, hostId: 'local' }),
      { lastActivityAt: index + 1 }
    )
    store.setWorktreeMeta(
      hostWorktreeTarget({ id: `repo-ssh::/fleet/ssh/wt-${index}`, hostId: 'ssh:conn-1' }),
      { lastActivityAt: index + 1 }
    )
  }
  const group = store.createProjectGroup({
    name: 'Bots',
    parentPath: testState.dir,
    createdFrom: 'folder-scan'
  })
  const folder = store.createFolderWorkspace({ projectGroupId: group.id })
  const botWorkspace = { worktreeId: folderWorkspaceKey(folder.id), sshHostId: null }
  writeLink(store, botWorkspace, {
    source: 'slack',
    externalId: 'T1:C1:100.1',
    sessionId: SLACK_SESSION,
    agent: 'claude',
    paneKey: `chat:${SLACK_SESSION}`,
    bot: { kind: 'bot', botId: 'bot-1' },
    place: '#releases',
    createdAt: 1
  })
  for (let index = 0; index < 20; index += 1) {
    writeLink(store, botWorkspace, {
      source: 'slack',
      externalId: `T1:C1:200.${index}`,
      sessionId: `session-thread-${index}`,
      agent: 'claude',
      paneKey: `chat:session-thread-${index}`,
      bot: { kind: 'bot', botId: 'bot-1' },
      createdAt: index + 2
    })
  }

  let focused = false
  let now = 10_000
  const desktopBodies: string[] = []
  const mobileBodies: string[] = []
  const focusedWindow = { isFocused: () => focused } as unknown as BrowserWindow
  const settings = {
    ...getDefaultNotificationSettings(),
    suppressWhenFocused: true,
    mutedNotificationSourceIds: ['runtime:muted-host' as const]
  }
  const desktop = createNotificationDeliveryService({
    readNotificationSettings: () => settings,
    findActiveWindow: () => focusedWindow,
    isWindowVisible: () => true,
    setTrayAttention: () => {},
    isNotificationSupported: () => true,
    dispatchMobileNotification: null,
    readAuthorizationStatus: async () => 'authorized',
    recordDeliveryOutcome: () => {},
    deliverNative: (_request, options) => {
      desktopBodies.push(options.body)
      return { delivered: true }
    },
    platform: 'linux',
    now: () => now,
    repliesInSlack: (sessionId) => sessionRepliesInSlack(store, sessionId)
  })
  const mobile = createStructuredAttentionMobileDelivery({
    readNotificationSettings: () => settings,
    readWorkspaceLabels: () => ({ worktreeLabel: 'Bot' }),
    isMuted: () => false,
    readOrchestration: () => undefined,
    repliesInSlack: (sessionId) => sessionRepliesInSlack(store, sessionId),
    dispatch: (event) => mobileBodies.push(event.body),
    reconcile: () => {},
    now: () => now
  })

  const notifyTurn = (
    sessionId: string,
    message: string,
    turn: number,
    overrides: Partial<NotificationDispatchRequest> = {}
  ) => {
    now += 60_000
    const worktreeId = `repo-local::/fleet/local/wt-${turn % worktreesPerHost}`
    mobile.deliver(
      {
        type: 'completion',
        completion: {
          scope: {
            executionHostId: 'local',
            wslDistro: null,
            workspaceId: worktreeId,
            workspaceKind: 'git-worktree'
          },
          sessionId,
          turnId: `turn-${turn}`,
          outcome: 'success',
          completedAt: now
        }
      },
      {
        sessionId,
        workspaceId: worktreeId,
        agent: 'claude',
        status: 'idle',
        lastAssistantMessage: message,
        updatedAt: now
      }
    )
    return desktop.dispatch({
      source: 'agent-task-complete',
      surface: 'agent-session',
      worktreeId,
      agentType: 'claude',
      agentState: 'done',
      agentTurnOutcome: 'success',
      agentLastAssistantMessage: message,
      attentionKey: `edge:${sessionId}:${turn}`,
      structuredOrigin: { kind: 'turn', sessionId, turnId: `turn-${turn}` },
      mobileDeliveredByHost: true,
      ...overrides
    })
  }

  return {
    store,
    folderId: folder.id,
    desktop,
    notifyTurn,
    desktopBodies,
    mobileBodies,
    setFocused: (value: boolean) => {
      focused = value
    }
  }
}

describe('structured chat notification link lookups', () => {
  it.each([
    [50, { coldSkipped: 0, warmHosts: 2, warmFolders: 1 }],
    [500, { coldSkipped: 0, warmHosts: 2, warmFolders: 1 }]
  ])(
    'skip link scans before admission or Slack markup and keep one index across sort stamps (N=%i)',
    (worktreesPerHost, expected) => {
      const fleet = buildFleet(worktreesPerHost)
      vi.useFakeTimers()
      const hostProjections = vi.spyOn(fleet.store, 'getAllWorktreeMetaForHost')
      const folderReads = vi.spyOn(fleet.store, 'getFolderWorkspaces')

      // Suppressed, muted, and non-Slack-token notifications touch zero link inventories on a cold store.
      fleet.setFocused(true)
      expect(
        fleet.desktop.dispatch({
          source: 'agent-task-complete',
          surface: 'agent-session',
          worktreeId: 'repo-local::/fleet/local/wt-0',
          isActiveWorktree: true,
          agentType: 'claude',
          agentState: 'done',
          agentTurnOutcome: 'success',
          agentLastAssistantMessage: SLACK_REPLY,
          structuredOrigin: { kind: 'turn', sessionId: SLACK_SESSION, turnId: 'suppressed' },
          mobileDeliveredByHost: true
        })
      ).toEqual({ delivered: false, reason: 'suppressed-focus' })
      fleet.setFocused(false)
      expect(
        fleet.desktop.dispatch({
          source: 'agent-task-complete',
          surface: 'agent-session',
          worktreeId: 'repo-local::/fleet/local/wt-0',
          notificationSourceId: 'runtime:muted-host',
          agentType: 'claude',
          agentState: 'done',
          agentTurnOutcome: 'success',
          agentLastAssistantMessage: SLACK_REPLY,
          structuredOrigin: { kind: 'turn', sessionId: SLACK_SESSION, turnId: 'muted' },
          mobileDeliveredByHost: true
        })
      ).toEqual({ delivered: false, reason: 'host-muted' })
      expect(fleet.notifyTurn(SLACK_SESSION, CODE_REPLY, 0)).toEqual({ delivered: true })
      expect(hostProjections.mock.calls.length).toBe(expected.coldSkipped)
      expect(folderReads.mock.calls.length).toBe(expected.coldSkipped)

      // Ten Slack-markup turns interleaved with activity and unread writes build the index once.
      for (let turn = 1; turn <= 10; turn += 1) {
        fleet.store.setWorktreeMeta(
          hostWorktreeTarget({
            id: `repo-local::/fleet/local/wt-${turn % worktreesPerHost}`,
            hostId: 'local'
          }),
          { lastActivityAt: 100_000 + turn, isUnread: true }
        )
        fleet.store.updateFolderWorkspace(fleet.folderId, {
          lastActivityAt: 100_000 + turn,
          isUnread: true
        })
        const sessionId = turn % 2 === 1 ? SLACK_SESSION : LOCAL_SESSION
        expect(fleet.notifyTurn(sessionId, SLACK_REPLY, turn)).toEqual({ delivered: true })
        expect(
          chatMailPlace(fleet.store, sessionId, {
            kind: 'agent',
            senders: [],
            orchestration: null
          })
        ).toEqual(
          sessionId === SLACK_SESSION
            ? { place: 'the Slack thread in #releases', answersThere: false }
            : null
        )
      }

      expect(hostProjections.mock.calls.length).toBe(expected.warmHosts)
      expect(folderReads.mock.calls.length).toBe(expected.warmFolders)
      expect(fleet.desktopBodies.slice(0, 3)).toEqual([
        CODE_REPLY,
        'Pinged @here and @sam.',
        SLACK_REPLY
      ])
      expect(fleet.mobileBodies.slice(0, 3)).toEqual([
        CODE_REPLY,
        'Pinged @here and @sam.',
        SLACK_REPLY
      ])

      // Linking the local session invalidates once and formats its next Slack reply.
      writeLink(
        fleet.store,
        { worktreeId: 'repo-local::/fleet/local/wt-0', sshHostId: null },
        {
          source: 'slack',
          externalId: 'T1:C1:999.1',
          sessionId: LOCAL_SESSION,
          agent: 'claude',
          paneKey: `chat:${LOCAL_SESSION}`,
          createdAt: 99
        }
      )
      expect(fleet.notifyTurn(LOCAL_SESSION, SLACK_REPLY, 11)).toEqual({ delivered: true })
      expect(fleet.notifyTurn(LOCAL_SESSION, SLACK_REPLY, 12)).toEqual({ delivered: true })
      expect(fleet.desktopBodies.at(-1)).toBe('Pinged @here and @sam.')
      expect(hostProjections.mock.calls.length).toBe(expected.warmHosts * 2)
    }
  )
})
