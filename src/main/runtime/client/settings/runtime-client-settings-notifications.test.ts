import { expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { CLIENT_UI_METHODS } from '../../rpc/methods/client-state/client-ui'
import { RuntimeClientSettingsController } from './runtime-client-settings'

vi.mock('../../../claude/agent-view/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))

function makeServer() {
  let stored: GlobalSettings = {
    ...getDefaultSettings('/home/user'),
    notifications: {
      ...getDefaultSettings('/home/user').notifications,
      customSoundId: 'custom',
      customSoundPath: '/home/user/ding.wav',
      mutedNotificationSourceIds: ['local']
    }
  }
  const settings = new RuntimeClientSettingsController({
    getSettings: () => stored,
    updateSettings: (updates) => {
      stored = { ...stored, ...updates }
    },
    runDurableMutation: vi.fn()
  })
  const fake = {
    getRuntimeId: () => 'server-runtime',
    getClientSettings: () => settings.get(),
    updateClientSettings: (updates: Parameters<typeof settings.update>[0]) =>
      settings.update(updates)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settings.get/update read only the members above.
  const runtime = fake as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
  let requestId = 0
  const call = (method: string, params?: unknown) =>
    dispatcher.dispatch(
      { id: `req-${++requestId}`, authToken: 'tok', method, params },
      { clientKind: 'mobile' }
    )
  return { call, stored: () => stored }
}

it("lets a paired client turn off a server's task-complete pushes without touching its sounds", async () => {
  const server = makeServer()
  const response = await server.call('settings.update', {
    hostNotifications: { agentTaskComplete: false },
    nativeChatQueueFollowUps: false,
    nativeChatCiResultLines: false
  })
  expect(response).toMatchObject({
    ok: true,
    result: {
      settings: {
        hostNotifications: {
          enabled: true,
          agentTaskComplete: false,
          agentNeedsInput: true,
          terminalBell: false
        },
        nativeChatQueueFollowUps: false,
        nativeChatCiResultLines: false
      }
    }
  })
  expect(server.stored().notifications).toMatchObject({
    agentTaskComplete: false,
    customSoundId: 'custom',
    customSoundPath: '/home/user/ding.wav',
    mutedNotificationSourceIds: ['local']
  })
})

it('refuses client-only notification settings', async () => {
  const server = makeServer()
  const response = await server.call('settings.update', {
    hostNotifications: { customSoundPath: '/tmp/x.wav' }
  })
  expect(response).toMatchObject({ ok: false })
  expect(server.stored().notifications.customSoundPath).toBe('/home/user/ding.wav')
})
