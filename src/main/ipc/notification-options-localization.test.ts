import { automationOutcomeNotification } from '../automations/automation-outcome-notification'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NotificationDispatchRequest } from '../../shared/notification-settings-types'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SPANISH } from '../../shared/ui-language'
import { setMainUiLanguage, translateMain } from '../i18n/main-i18n'
import { buildNotificationOptions } from './notification-options'

vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' } }))

const BELL: NotificationDispatchRequest = {
  source: 'terminal-bell',
  worktreeId: 'wt-1',
  worktreeLabel: 'feature-x',
  repoLabel: 'orca'
}
const TOOL: NotificationDispatchRequest = {
  source: 'agent-task-complete',
  worktreeId: 'wt-1',
  agentType: 'claude',
  agentState: 'working',
  agentToolName: 'Bash',
  agentToolInput: 'ls {{tool}}'
}
const FALLBACK: NotificationDispatchRequest = { source: 'agent-task-complete', worktreeId: 'wt-1' }

afterEach(async () => {
  await setMainUiLanguage(UI_LANGUAGE_ENGLISH)
})

describe('buildNotificationOptions localization', () => {
  it('reads the copy from the active catalog', async () => {
    await setMainUiLanguage(UI_LANGUAGE_SPANISH)

    expect(buildNotificationOptions(BELL, translateMain)).toEqual({
      title: 'Campana en feature-x',
      body: 'orca · Se solicita atención'
    })
    expect(buildNotificationOptions(TOOL, translateMain)).toEqual({
      title: 'espacio de trabajo - Claude trabajando',
      body: 'Usando Bash: ls {{tool}}'
    })
    expect(buildNotificationOptions(FALLBACK, translateMain)).toEqual({
      title: 'Tarea completada en espacio de trabajo',
      body: 'Un agente de programación terminó de trabajar.'
    })
  })
})

it.each(['projectSetupNotReady', 'wslDistroStopped'] as const)(
  'uses the actual translated safe parameterized automation reason %s',
  async (errorCode) => {
    await setMainUiLanguage(UI_LANGUAGE_SPANISH)
    const request = automationOutcomeNotification({
      name: 'A'.repeat(200),
      agentId: 'codex',
      run: {
        id: 'r',
        automationId: 'a',
        status: 'dispatch_failed',
        sessionKind: 'chat',
        createdAt: 1,
        dispatchedAt: null,
        workspaceId: null,
        chatSessionId: null,
        terminalPaneKey: null,
        terminalPtyId: null
      },
      presentation: {
        failure:
          errorCode === 'projectSetupNotReady'
            ? { errorCode, errorParams: { setupState: 'setting-up' } }
            : { errorCode, errorParams: { distro: 'Ubuntu' } }
      }
    })
    if (!request) {
      throw new Error('Expected actual pane-less request')
    }
    const options = buildNotificationOptions(request, translateMain)
    expect(options.title).toContain('Codex')
    expect(options.title.length).toBeLessThan(110)
    expect(options.body).toContain('Codex: ')
    expect(options.body).toContain(
      errorCode === 'projectSetupNotReady'
        ? translateMain(
            'automations.runFailures.projectSetupState.settingUp',
            'missing translation'
          )
        : 'Ubuntu'
    )
    expect(options.body).toContain('Revisa la ejecución e inténtalo de nuevo.')
    expect(options.body).not.toContain('{{')
    expect(options.body).not.toContain(errorCode)
  }
)
