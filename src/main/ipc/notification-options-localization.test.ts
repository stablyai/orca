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
