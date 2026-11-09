import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../../../shared/constants'
import '../../../../../shared/electron-remote-runtime-client-capabilities'
import '../../../../../shared/remote-runtime/remote-runtime-client-capabilities'
import { LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH } from '../../../../../shared/terminal/quick-commands/terminal-quick-command-prompt-limit'
import type { TerminalQuickCommand } from '../../../../../shared/terminal/quick-commands/terminal-quick-command-types'
import type { TerminalQuickCommandMutation } from '../../../../../shared/terminal/quick-commands/terminal-quick-commands'
import '../../../../../shared/web-runtime-client-capabilities'
import { TERMINAL_QUICK_COMMAND_LARGE_LISTS_RUNTIME_CAPABILITY } from '../../../../../shared/terminal/quick-commands/terminal-quick-command-capabilities'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import '../../../../ipc/desktop-renderer-runtime-capabilities'
import { RuntimeClientSettingsController } from '../../../client/settings/runtime-client-settings'
import {
  updateSettings,
  type SettingsMutationOperations
} from '../../../../persistence/applying-settings/settings-update'
import type { RpcRequest } from '../../core'
import { RpcDispatcher } from '../../dispatcher'
import '../../runtime-client-capabilities'
import { CLIENT_UI_METHODS } from '../client-state/client-ui'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('quick-command client compatibility', () => {
  const shortCommand: TerminalQuickCommand = {
    id: 'status',
    label: 'Status',
    action: 'terminal-command',
    command: 'git status',
    appendEnter: true,
    scope: { type: 'global' }
  }
  const longCommand: TerminalQuickCommand = {
    id: 'review',
    label: 'Review',
    action: 'agent-prompt',
    agent: 'claude',
    prompt: 'x'.repeat(LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH + 1),
    scope: { type: 'global' }
  }

  function makeDispatcher(commands = [shortCommand, longCommand]) {
    const state = getDefaultPersistedState('/tmp')
    state.settings.terminalQuickCommands = commands
    const scheduleSave = vi.fn()
    const operations: SettingsMutationOperations = {
      state,
      bumpLocalWorktreeScanGeneration: vi.fn(),
      removeRetainedBlob: vi.fn(),
      scheduleSave,
      notifySettingsChanged: vi.fn()
    }
    const settings = new RuntimeClientSettingsController({
      getSettings: () => state.settings,
      updateSettings: (updates, options) => updateSettings(operations, updates, options)
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers call only the quick-command methods stubbed here.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientTerminalQuickCommands: () => settings.getTerminalQuickCommands(),
      updateClientTerminalQuickCommands: (mutation: TerminalQuickCommandMutation) =>
        settings.updateTerminalQuickCommands(mutation)
    } as unknown as OrcaRuntimeService
    return {
      dispatcher: new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS }),
      state,
      scheduleSave
    }
  }

  it('lets legacy clients edit and delete visible commands while preserving hidden commands', async () => {
    const commands = Array.from({ length: 45 }, (_, index) => ({
      ...shortCommand,
      id: `command-${index}`
    }))
    const { dispatcher, state } = makeDispatcher(commands)
    const caller = { clientKind: 'runtime' as const, clientCapabilities: [] }
    const edited = { ...commands[0], label: 'Edited command' }

    const editResponse = await dispatcher.dispatch(
      makeRequest('settings.updateTerminalQuickCommands', {
        mutation: { type: 'upsert', command: edited }
      }),
      caller
    )
    expect(editResponse).toMatchObject({
      ok: true,
      result: { terminalQuickCommands: [edited, ...commands.slice(1, 40)] }
    })

    const deleteResponse = await dispatcher.dispatch(
      makeRequest('settings.updateTerminalQuickCommands', {
        mutation: { type: 'delete', id: commands[1].id }
      }),
      caller
    )
    expect(deleteResponse).toMatchObject({
      ok: true,
      result: { terminalQuickCommands: [edited, ...commands.slice(2, 41)] }
    })
    expect(state.settings.terminalQuickCommands).toEqual([edited, ...commands.slice(2)])
  })

  it.each(['runtime', 'mobile'] as const)(
    'refuses a stale %s client edit of a hidden prompt before saving anything',
    async (clientKind) => {
      const { dispatcher, state, scheduleSave } = makeDispatcher()

      const response = await dispatcher.dispatch(
        makeRequest('settings.updateTerminalQuickCommands', {
          mutation: { type: 'upsert', command: { ...longCommand, prompt: 'Stale short prompt' } }
        }),
        {
          clientKind,
          clientCapabilities: [TERMINAL_QUICK_COMMAND_LARGE_LISTS_RUNTIME_CAPABILITY]
        }
      )

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_argument',
          message: expect.stringContaining('Update this Orca client')
        }
      })
      expect(state.settings.terminalQuickCommands).toEqual([shortCommand, longCommand])
      expect(scheduleSave).not.toHaveBeenCalled()
    }
  )
})
