import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { getDefaultNotificationSettings } from '../../../../shared/notifications/notification-settings-defaults'
import type * as NotificationOptions from '../../../ipc/notifications/notification-options'
import { TerminalAgentPhonePush } from './terminal-agent-phone-push'

const built = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../ipc/notifications/notification-options', async (load) => {
  const actual = await load<typeof NotificationOptions>()
  return {
    ...actual,
    buildNotificationOptions: (...args: Parameters<typeof actual.buildNotificationOptions>) => {
      built.count += 1
      return actual.buildNotificationOptions(...args)
    }
  }
})

const workspace = { worktreeId: 'repo-1::/work/feature', sshHostId: null }

/** `panes` agents each finish once; each read of a hook row is a fresh object, as production's
 *  projection returns, and `reply` is the reply a transcript read adds within the quiet window. */
function finishBurst(panes: number, host: { window: boolean; reply: string | undefined }) {
  built.count = 0
  const rows = new Map<string, AgentStatusIpcPayload>()
  const timers: (() => void)[] = []
  const sent: unknown[] = []
  const push = new TerminalAgentPhonePush({
    hasWindow: () => host.window,
    readNotificationSettings: () => getDefaultNotificationSettings(),
    readWorkspaceLabels: () => ({ worktreeLabel: 'feature' }),
    isWorkspaceMuted: () => false,
    readOrchestration: () => undefined,
    readTerminalTitle: () => null,
    readHookRow: (paneKey) => {
      const row = rows.get(paneKey)
      return row ? { ...row } : null
    },
    dispatch: (event) => sent.push(event),
    onClientEvent: () => () => {},
    setTimer: (run) => {
      timers.push(run)
      return { cancel: () => {} }
    },
    now: () => 1_000_000
  })
  for (let index = 0; index < panes; index += 1) {
    const paneKey = `tab-${index}:leaf-1`
    const turn = { paneKey, agentType: 'droid', connectionId: null, prompt: 'go' } as const
    rows.set(paneKey, { ...turn, state: 'working', receivedAt: 1, stateStartedAt: 1 })
    push.observe({ kind: 'observed', paneKey, workspace, phase: 'working', at: 1 })
    rows.set(paneKey, {
      ...turn,
      state: 'done',
      receivedAt: 2,
      stateStartedAt: 2,
      turnCompletedAt: 2
    })
    push.observe({
      kind: 'moved',
      paneKey,
      workspace,
      from: 'working',
      to: 'done',
      at: 2,
      transition: 'turn-finished'
    })
    if (host.reply !== undefined) {
      rows.set(paneKey, { ...rows.get(paneKey)!, lastAssistantMessage: host.reply })
    }
  }
  for (const run of timers.splice(0)) {
    run()
  }
  return { builds: built.count, sent: sent.length }
}

// Guards #44649's perf review: a late-reply alert was rebuilt before window/mute suppression and
// before the burst cooldown, so every finish in a burst built its alert twice.
describe('phone finish alerts at the quiet window', () => {
  it.each([
    [100, { windowOwned: 100, quiet: 100, lateReply: 101 }],
    [1_000, { windowOwned: 1_000, quiet: 1_000, lateReply: 1_001 }]
  ])('build each alert once, and rebuild only the late reply a phone gets (N=%i)', (n, builds) => {
    expect(finishBurst(n, { window: true, reply: 'Done.' })).toEqual({
      builds: builds.windowOwned,
      sent: 0
    })
    expect(finishBurst(n, { window: false, reply: undefined })).toEqual({
      builds: builds.quiet,
      sent: 1
    })
    // The workspace cooldown sends one alert per burst, and only that one is rebuilt.
    expect(finishBurst(n, { window: false, reply: 'Done.' })).toEqual({
      builds: builds.lateReply,
      sent: 1
    })
  })
})
