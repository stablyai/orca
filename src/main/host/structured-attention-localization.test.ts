import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionAttentionEdge } from '../../shared/agent-session-attention'
import { getDefaultNotificationSettings } from '../../shared/notification-settings-defaults'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SPANISH } from '../../shared/ui-language'
import { setMainUiLanguage } from '../i18n/main-i18n'
import { createNotificationDeliveryService } from '../notifications/notification-delivery-service'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from '../runtime/runtime-mobile-notification-controller'
import { setRuntimeDesktopSurface } from '../runtime/runtime-desktop-surface'
import { createStructuredAttentionMobileDelivery } from '../runtime/structured-agent-session-mobile-attention'
import { electronRuntimeDesktopSurface } from './electron-runtime-desktop-surface'

vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  BrowserWindow: {},
  ipcMain: {},
  Notification: {},
  powerMonitor: {}
}))

const SCOPE = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'folder-a',
  workspaceKind: 'folder'
} as const

function prompt(promptId: string): AgentSessionAttentionEdge {
  return {
    type: 'prompt',
    prompt: {
      scope: SCOPE,
      sessionId: 'session-a',
      promptId,
      raisedAt: 1,
      journalCursor: { epoch: 'journal-a', sequence: 1 }
    }
  }
}

function hostNotifications() {
  const events: MobileNotificationEvent[] = []
  const controller = new RuntimeMobileNotificationController()
  controller.onDispatched((event) => events.push(event))
  const delivery = createStructuredAttentionMobileDelivery({
    readNotificationSettings: getDefaultNotificationSettings,
    readWorkspaceLabels: () => ({ worktreeLabel: 'Notes' }),
    dispatch: (event) => controller.dispatch(event),
    reconcile: (state) => controller.reconcileStructuredPromptAttention(state),
    now: () => 60_000
  })
  return { delivery, events }
}

beforeEach(async () => {
  await setMainUiLanguage(UI_LANGUAGE_ENGLISH)
  setRuntimeDesktopSurface(electronRuntimeDesktopSurface)
})

afterEach(async () => {
  setRuntimeDesktopSurface(null)
  await setMainUiLanguage(UI_LANGUAGE_ENGLISH)
})

describe('structured host notification localization', () => {
  it('reads language changes on the existing desktop host delivery', async () => {
    const host = hostNotifications()
    host.delivery.deliver(prompt('A'), undefined)
    await setMainUiLanguage(UI_LANGUAGE_SPANISH)
    host.delivery.deliver(prompt('B'), undefined)
    await setMainUiLanguage(UI_LANGUAGE_ENGLISH)
    host.delivery.deliver(prompt('C'), undefined)

    expect(
      host.events.filter((event) => event.type === 'notification').map((event) => event.title)
    ).toEqual([
      'Notes - Agent needs input',
      'Notes - Agent necesita información',
      'Notes - Agent needs input'
    ])
  })

  it('reads surface replacement at delivery time and keeps headless English defaults', async () => {
    const host = hostNotifications()
    await setMainUiLanguage(UI_LANGUAGE_SPANISH)
    setRuntimeDesktopSurface(null)
    host.delivery.deliver(prompt('A'), undefined)
    setRuntimeDesktopSurface(electronRuntimeDesktopSurface)
    host.delivery.deliver(prompt('B'), undefined)

    expect(
      host.events.filter((event) => event.type === 'notification').map((event) => event.title)
    ).toEqual(['Notes - Agent needs input', 'Notes - Agent necesita información'])
  })

  it.each([
    ['success', 'finalizado'],
    ['failure', 'fallido'],
    ['cancellation', 'detenido']
  ] as const)('preserves the localized %s outcome', async (outcome, status) => {
    const host = hostNotifications()
    await setMainUiLanguage(UI_LANGUAGE_SPANISH)
    host.delivery.deliver(
      {
        type: 'completion',
        completion: {
          scope: SCOPE,
          sessionId: 'session-a',
          turnId: 'turn-a',
          outcome,
          completedAt: 1
        }
      },
      undefined
    )

    expect(host.events).toEqual([
      expect.objectContaining({ title: `Notes - Agent ${status}`, body: `Agent ${status}.` })
    ])
  })

  it('keeps desktop native and relayed phone copy localized without the runtime facet', async () => {
    await setMainUiLanguage(UI_LANGUAGE_SPANISH)
    setRuntimeDesktopSurface(null)
    const events: MobileNotificationEvent[] = []
    const native: { title: string; body: string }[] = []
    const controller = new RuntimeMobileNotificationController()
    controller.onDispatched((event) => events.push(event))
    const service = createNotificationDeliveryService({
      readNotificationSettings: getDefaultNotificationSettings,
      findActiveWindow: () => null,
      isWindowVisible: () => true,
      setTrayAttention: () => {},
      isNotificationSupported: () => true,
      dispatchMobileNotification: (event) => controller.dispatch(event),
      readAuthorizationStatus: () => Promise.resolve('authorized'),
      recordDeliveryOutcome: () => {},
      deliverNative: (_request, options) => {
        native.push(options)
        return { delivered: true }
      },
      platform: 'linux',
      now: () => 60_000
    })

    expect(
      await service.dispatch({
        source: 'agent-task-complete',
        worktreeId: 'folder-a',
        worktreeLabel: 'Notes',
        agentType: 'claude',
        agentState: 'blocked',
        agentLastAssistantMessage: 'Approve the migration?'
      })
    ).toEqual({ delivered: true })
    const copy = { title: 'Notes - Claude necesita información', body: 'Approve the migration?' }
    expect(native).toEqual([copy])
    expect(events).toEqual([expect.objectContaining(copy)])
  })
})
