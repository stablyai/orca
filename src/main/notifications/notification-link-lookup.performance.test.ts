// Perf contract (#45503, STA-16839): structured chat notifications and Slack mirror link writes
// must not rebuild fleet worktree projections, reparse unrelated links, or rebuild unrelated index buckets.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAttentionOrigin } from '../../shared/agent-session/view/agent-session-attention'
import { getDefaultNotificationSettings } from '../../shared/notifications/notification-settings-defaults'
import type { NotificationDispatchRequest } from '../../shared/notifications/notification-settings-types'
import { removeTempDirs } from '../../shared/testing/remove-temp-dirs.test-support'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type * as LinkBuckets from '../external-conversations/external-conversation-link-buckets'
import type * as LinkParser from '../external-conversations/external-conversation-link-parser'
import {
  allLinks,
  chatMailPlace,
  findLink,
  removeLink,
  sessionRepliesInSlack,
  writeLink
} from '../external-conversations/external-conversation-links'
import { SlackMirror } from '../external-conversations/slack-mirror'
import type { SlackMirrorCloud } from '../external-conversations/slack-mirror-cloud'
import {
  closeTestStores,
  createStore,
  makeRepo,
  testState
} from '../persistence/persistence-test-harness'
import { createStructuredAttentionMobileDelivery } from '../runtime/agent-session/lifecycle/structured-agent-session-mobile-attention'
import { createNotificationDeliveryService } from './notification-delivery-service'

const windowFocus = vi.hoisted(() => ({ focused: false }))
const linkReads = vi.hoisted(() => ({ calls: 0, rows: 0 }))
const bucketWrites = vi.hoisted(() => ({ calls: 0 }))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: class {
    isFocused(): boolean {
      return windowFocus.focused
    }
  }
}))
vi.mock('../external-conversations/external-conversation-link-parser', async (load) => {
  const actual = await load<typeof LinkParser>()
  return {
    ...actual,
    linksOf: (value: unknown) => {
      linkReads.calls += 1
      linkReads.rows += Array.isArray(value) ? value.length : 0
      return actual.linksOf(value)
    }
  }
})
vi.mock('../external-conversations/external-conversation-link-buckets', async (load) => {
  const actual = await load<typeof LinkBuckets>()
  return {
    ...actual,
    updateKeyBucket: (...args: Parameters<typeof actual.updateKeyBucket>) => {
      bucketWrites.calls += 1
      return actual.updateKeyBucket(...args)
    }
  }
})

const SLACK_SESSION = 'session-slack'
const SECOND_SLACK_SESSION = 'session-thread-0'
const LOCAL_SESSION = 'session-local'
const SLACK_KEY = { source: 'slack', externalId: 'T1:C1:100.1' } as const
const SLACK_REPLY = 'Pinged <!here> and <@U12345ABC|sam>.'
const CODE_REPLY = 'Updated Array<string> and <div> layout.'

function originFor(
  worktreeId: string,
  sessionId: string,
  sequence: number
): StructuredAttentionOrigin {
  return {
    scope: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: worktreeId,
      workspaceKind: 'git-worktree'
    },
    sessionId,
    cause: { kind: 'completion', requestId: `turn-${sequence}` },
    journalCursor: { epoch: 'epoch-1', sequence }
  }
}

const dirs: string[] = []
afterEach(async () => {
  windowFocus.focused = false
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
  const savedMirrorPosts = {
    [agentJournalSubmissionKey('old-1')]: { state: 'posted' as const, at: 1 },
    [agentJournalSubmissionKey('old-2')]: { state: 'posted' as const, at: 2 }
  }
  for (let index = 0; index < worktreesPerHost; index += 1) {
    store.setWorktreeMeta(
      hostWorktreeTarget({ id: `repo-local::/fleet/local/wt-${index}`, hostId: 'local' }),
      {
        lastActivityAt: index + 1,
        externalConversations: [
          {
            source: 'slack',
            externalId: `T1:LOCAL:${index}`,
            sessionId: `session-local-wt-${index}`,
            agent: 'claude',
            paneKey: `chat:session-local-wt-${index}`,
            mirrorPosts: savedMirrorPosts,
            createdAt: 1
          }
        ]
      }
    )
    store.setWorktreeMeta(
      hostWorktreeTarget({ id: `repo-ssh::/fleet/ssh/wt-${index}`, hostId: 'ssh:conn-1' }),
      {
        lastActivityAt: index + 1,
        externalConversations: [
          {
            source: 'slack',
            externalId: `T1:SSH:${index}`,
            sessionId: `session-ssh-wt-${index}`,
            agent: 'claude',
            paneKey: `chat:session-ssh-wt-${index}`,
            mirrorPosts: savedMirrorPosts,
            createdAt: 1
          }
        ]
      }
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
    ...SLACK_KEY,
    sessionId: SLACK_SESSION,
    agent: 'claude',
    paneKey: `chat:${SLACK_SESSION}`,
    bot: { kind: 'bot', botId: 'bot-1' },
    place: '#releases',
    mirror: true,
    mirrorChosen: true,
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
      mirror: true,
      mirrorChosen: true,
      mirrorPosts: savedMirrorPosts,
      createdAt: index + 2
    })
  }

  let now = 10_000
  const desktopBodies: string[] = []
  const mobileBodies: string[] = []
  const focusedWindow = new BrowserWindow()
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
    const origin = originFor(worktreeId, sessionId, turn)
    mobile.deliver(
      {
        type: 'completion',
        completion: {
          scope: origin.scope,
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
        status: 'attention',
        latestPrompt: 'Ship it',
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
      structuredOrigin: origin,
      mobileDeliveredByHost: true,
      ...overrides
    })
  }

  const mirrorPostsSent: number[] = []
  const cloud: SlackMirrorCloud = {
    cloudFeatures: () => new Set(['slack.mirror']),
    call: async (_path, _body, schema) => {
      mirrorPostsSent.push(1)
      return { ok: true, value: schema.parse({ ts: `${mirrorPostsSent.length}.0` }) }
    }
  }

  return {
    store,
    folderId: folder.id,
    botWorkspace,
    desktop,
    notifyTurn,
    desktopBodies,
    mobileBodies,
    mirrorPostsSent,
    createMirror: () =>
      new SlackMirror({
        store,
        cloud: () => cloud,
        orcaName: () => 'Alice',
        botSetting: () => undefined,
        readMessage: async () => null,
        emitTurnEnd: () => true,
        signal: new AbortController().signal
      }),
    setFocused: (value: boolean) => {
      windowFocus.focused = value
    }
  }
}

describe('structured chat notification and mirror link lookups', () => {
  it.each([
    [
      50,
      {
        coldSkipped: 0,
        warmHosts: 2,
        warmFolders: 1,
        alternatingParseCalls: 42,
        alternatingParseRows: 882,
        alternatingBucketWrites: 36,
        freshLinkParseCalls: 17,
        freshLinkParseRows: 296,
        freshLinkBucketWrites: 15,
        totalEnumeratedLinks: 122
      }
    ],
    [
      500,
      {
        coldSkipped: 0,
        warmHosts: 2,
        warmFolders: 1,
        alternatingParseCalls: 42,
        alternatingParseRows: 882,
        alternatingBucketWrites: 36,
        freshLinkParseCalls: 17,
        freshLinkParseRows: 296,
        freshLinkBucketWrites: 15,
        totalEnumeratedLinks: 1022
      }
    ]
  ])(
    'gate notification lookups and update single-workspace buckets without fleet rebuilds (N=%i)',
    async (worktreesPerHost, expected) => {
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
          structuredOrigin: originFor('repo-local::/fleet/local/wt-0', SLACK_SESSION, 100),
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
          structuredOrigin: originFor('repo-local::/fleet/local/wt-0', SLACK_SESSION, 101),
          mobileDeliveredByHost: true
        })
      ).toEqual({ delivered: false, reason: 'host-muted' })
      expect(fleet.notifyTurn(SLACK_SESSION, CODE_REPLY, 0)).toEqual({ delivered: true })
      expect(hostProjections.mock.calls.length).toBe(expected.coldSkipped)
      expect(folderReads.mock.calls.length).toBe(expected.coldSkipped)

      // Ten Slack-markup turns interleaved with activity and unread writes build the index once.
      const mailSource = { kind: 'agent', senders: [], orchestration: null } as const
      for (let pair = 0; pair < 5; pair += 1) {
        const slackTurn = pair * 2 + 1
        const localTurn = pair * 2 + 2
        fleet.store.setWorktreeMeta(
          hostWorktreeTarget({
            id: `repo-local::/fleet/local/wt-${slackTurn % worktreesPerHost}`,
            hostId: 'local'
          }),
          { lastActivityAt: 100_000 + slackTurn, isUnread: true }
        )
        fleet.store.updateFolderWorkspace(fleet.folderId, {
          lastActivityAt: 100_000 + slackTurn,
          isUnread: true
        })
        expect(fleet.notifyTurn(SLACK_SESSION, SLACK_REPLY, slackTurn)).toEqual({ delivered: true })
        expect(chatMailPlace(fleet.store, SLACK_SESSION, mailSource)).toMatchObject({
          answersThere: false
        })
        expect(fleet.notifyTurn(LOCAL_SESSION, SLACK_REPLY, localTurn)).toEqual({ delivered: true })
        expect(chatMailPlace(fleet.store, LOCAL_SESSION, mailSource)).toBeNull()
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

      // Six alternating Slack mirror posts across two chats in one bot workspace update only the active chat's buckets.
      const mirror = fleet.createMirror()
      hostProjections.mockClear()
      folderReads.mockClear()
      linkReads.calls = 0
      linkReads.rows = 0
      bucketWrites.calls = 0
      for (let round = 0; round < 3; round += 1) {
        for (const [offset, sessionId] of [
          [1, SLACK_SESSION],
          [2, SECOND_SLACK_SESSION]
        ] as const) {
          const post = round * 2 + offset
          mirror.admitted({
            sessionId,
            workspaceId: fleet.botWorkspace.worktreeId,
            clientMessageId: `send-${post}`,
            body: {
              kind: 'message',
              role: 'user',
              blocks: [{ type: 'text', text: `Update ${post}` }]
            },
            joinsRunningTurn: false
          })
          await vi.advanceTimersByTimeAsync(0)
        }
      }
      expect(fleet.mirrorPostsSent).toHaveLength(6)
      expect(hostProjections.mock.calls.length).toBe(0)
      expect(folderReads.mock.calls.length).toBe(0)
      expect(linkReads.calls).toBe(expected.alternatingParseCalls)
      expect(linkReads.rows).toBe(expected.alternatingParseRows)
      expect(bucketWrites.calls).toBe(expected.alternatingBucketWrites)

      // Linking a previously unseen worktree followed by reordered mirror posts still touches zero fleet projections or unrelated links.
      hostProjections.mockClear()
      folderReads.mockClear()
      linkReads.calls = 0
      linkReads.rows = 0
      bucketWrites.calls = 0
      const freshWorktree = { worktreeId: 'repo-local::/fleet/local/wt-fresh', sshHostId: null }
      writeLink(fleet.store, freshWorktree, {
        source: 'slack',
        externalId: 'T1:FRESH:1',
        sessionId: 'session-fresh',
        agent: 'claude',
        paneKey: 'chat:session-fresh',
        createdAt: 50
      })
      for (const [post, sessionId] of [
        [7, SLACK_SESSION],
        [8, SECOND_SLACK_SESSION]
      ] as const) {
        mirror.admitted({
          sessionId,
          workspaceId: fleet.botWorkspace.worktreeId,
          clientMessageId: `send-${post}`,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: `After fresh ${post}` }]
          },
          joinsRunningTurn: false
        })
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(fleet.mirrorPostsSent).toHaveLength(8)
      expect(hostProjections.mock.calls.length).toBe(0)
      expect(folderReads.mock.calls.length).toBe(0)
      expect(linkReads.calls).toBe(expected.freshLinkParseCalls)
      expect(linkReads.rows).toBe(expected.freshLinkParseRows)
      expect(bucketWrites.calls).toBe(expected.freshLinkBucketWrites)

      // Host ownership, scan-order precedence (worktrees before folders), relink, and removal stay exact without fleet rebuilds.
      expect(findLink(fleet.store, { source: 'slack', externalId: 'T1:SSH:0' })?.workspace).toEqual(
        {
          worktreeId: 'repo-ssh::/fleet/ssh/wt-0',
          sshHostId: 'ssh:conn-1'
        }
      )
      const localWorktree = { worktreeId: 'repo-local::/fleet/local/wt-0', sshHostId: null }
      writeLink(fleet.store, localWorktree, {
        ...SLACK_KEY,
        sessionId: LOCAL_SESSION,
        agent: 'claude',
        paneKey: `chat:${LOCAL_SESSION}`,
        createdAt: 99
      })
      expect(findLink(fleet.store, SLACK_KEY)?.workspace).toEqual(localWorktree)
      expect(fleet.notifyTurn(LOCAL_SESSION, SLACK_REPLY, 11)).toEqual({ delivered: true })
      expect(fleet.desktopBodies.at(-1)).toBe('Pinged @here and @sam.')
      expect(removeLink(fleet.store, SLACK_KEY)?.workspace).toEqual(localWorktree)
      expect(findLink(fleet.store, SLACK_KEY)?.workspace).toEqual(fleet.botWorkspace)
      expect(hostProjections.mock.calls.length).toBe(0)
      expect([...allLinks(fleet.store)]).toHaveLength(expected.totalEnumeratedLinks)
    }
  )
})
