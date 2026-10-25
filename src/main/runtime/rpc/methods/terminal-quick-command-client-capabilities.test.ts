import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../../shared/constants'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime-client-capabilities'
import { LEGACY_MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH } from '../../../../shared/terminal-quick-command-prompt-limit'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import type { TerminalQuickCommandMutation } from '../../../../shared/terminal-quick-commands'
import { WEB_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/web-runtime-client-capabilities'
import {
  TERMINAL_QUICK_COMMAND_LARGE_LISTS_RUNTIME_CAPABILITY,
  TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY
} from '../../../../shared/terminal-quick-command-capabilities'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import { RuntimeClientSettingsController } from '../../runtime-client-settings'
import {
  updateSettings,
  type SettingsMutationOperations
} from '../../../persistence/applying-settings/settings-update'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { parseRuntimeClientCapabilities } from '../runtime-client-capabilities'
import { CLIENT_UI_METHODS } from './client-ui'

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

  it('refuses a legacy client addition beyond forty before saving anything', async () => {
    const commands = Array.from({ length: 40 }, (_, index) => ({
      ...shortCommand,
      id: `command-${index}`
    }))
    const { dispatcher, state, scheduleSave } = makeDispatcher(commands)

    const response = await dispatcher.dispatch(
      makeRequest('settings.updateTerminalQuickCommands', {
        mutation: { type: 'upsert', command: shortCommand }
      }),
      { clientKind: 'runtime', clientCapabilities: [] }
    )

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: expect.stringContaining('Update this Orca client')
      }
    })
    expect(state.settings.terminalQuickCommands).toEqual(commands)
    expect(scheduleSave).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'local desktop',
      caller: {
        clientKind: 'runtime' as const,
        clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
      }
    },
    {
      name: 'paired desktop',
      caller: {
        clientKind: 'runtime' as const,
        clientCapabilities: parseRuntimeClientCapabilities(
          remoteRuntimeClientCapabilities(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES)
        )
      }
    },
    {
      name: 'web',
      caller: {
        clientKind: 'runtime' as const,
        clientCapabilities: parseRuntimeClientCapabilities(WEB_RUNTIME_CLIENT_CAPABILITIES)
      }
    },
    {
      name: 'CLI',
      caller: {
        clientKind: 'runtime' as const,
        clientCapabilities: parseRuntimeClientCapabilities(remoteRuntimeClientCapabilities())
      }
    },
    { name: 'in-process', caller: undefined }
  ])('saves and acknowledges command forty-one using $name capabilities', async ({ caller }) => {
    const commands = Array.from({ length: 40 }, (_, index) => ({
      ...shortCommand,
      id: `command-${index}`
    }))
    const { dispatcher, state, scheduleSave } = makeDispatcher(commands)

    const response = await dispatcher.dispatch(
      makeRequest('settings.updateTerminalQuickCommands', {
        mutation: { type: 'upsert', command: longCommand }
      }),
      caller
    )

    expect(response).toMatchObject({
      ok: true,
      result: { terminalQuickCommands: [...commands, longCommand] }
    })
    expect(state.settings.terminalQuickCommands).toEqual([...commands, longCommand])
    expect(scheduleSave).toHaveBeenCalledOnce()
  })

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

  it('does not count withheld prompts against a legacy client readable list', async () => {
    const commands = Array.from({ length: 39 }, (_, index) => ({
      ...shortCommand,
      id: `command-${index}`
    }))
    const { dispatcher, state } = makeDispatcher([longCommand, ...commands])

    const response = await dispatcher.dispatch(
      makeRequest('settings.updateTerminalQuickCommands', {
        mutation: { type: 'upsert', command: shortCommand }
      }),
      { clientKind: 'runtime', clientCapabilities: [] }
    )

    expect(response).toMatchObject({
      ok: true,
      result: { terminalQuickCommands: [...commands, shortCommand] }
    })
    expect(state.settings.terminalQuickCommands).toEqual([longCommand, ...commands, shortCommand])
  })

  it('refuses an edit that would be withheld from its caller before changing the saved command', async () => {
    const { dispatcher, state, scheduleSave } = makeDispatcher([shortCommand])

    const response = await dispatcher.dispatch(
      makeRequest('settings.updateTerminalQuickCommands', {
        mutation: { type: 'upsert', command: { ...longCommand, id: shortCommand.id } }
      }),
      {
        clientKind: 'runtime',
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
    expect(state.settings.terminalQuickCommands).toEqual([shortCommand])
    expect(scheduleSave).not.toHaveBeenCalled()
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

  it('stores a long prompt instead of refusing it', async () => {
    const { dispatcher, state } = makeDispatcher([shortCommand])
    const response = await dispatcher.dispatch(
      makeRequest('settings.updateTerminalQuickCommands', {
        mutation: { type: 'upsert', command: longCommand }
      })
    )

    expect(response).toMatchObject({
      ok: true,
      result: { terminalQuickCommands: [shortCommand, longCommand] }
    })
    expect(state.settings.terminalQuickCommands).toEqual([shortCommand, longCommand])
  })

  it('withholds long prompts from a client that cannot read them', async () => {
    const { dispatcher } = makeDispatcher()
    const olderClient = { clientKind: 'mobile' as const, clientCapabilities: [] }

    for (const request of [
      makeRequest('settings.getTerminalQuickCommands'),
      makeRequest('settings.updateTerminalQuickCommands', {
        mutation: { type: 'delete', id: 'other' }
      })
    ]) {
      const response = await dispatcher.dispatch(request, olderClient)
      expect(response).toMatchObject({
        ok: true,
        result: { terminalQuickCommands: [shortCommand] }
      })
    }
  })

  it('publishes long prompts to clients that advertise support and to in-process callers', async () => {
    const { dispatcher } = makeDispatcher()
    for (const options of [
      {
        clientKind: 'mobile' as const,
        clientCapabilities: [TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY]
      },
      undefined
    ]) {
      const response = await dispatcher.dispatch(
        makeRequest('settings.getTerminalQuickCommands'),
        options
      )
      expect(response).toMatchObject({
        ok: true,
        result: { terminalQuickCommands: [shortCommand, longCommand] }
      })
    }
  })

  it.each([false, true])(
    'projects large lists for older and current clients (support: %s)',
    async (supported) => {
      const commands = Array.from({ length: 100 }, (_, index) => ({
        ...shortCommand,
        id: `command-${index}`
      }))
      const { dispatcher } = makeDispatcher([longCommand, ...commands])
      const olderClient = {
        clientKind: 'mobile' as const,
        clientCapabilities: supported ? [TERMINAL_QUICK_COMMAND_LARGE_LISTS_RUNTIME_CAPABILITY] : []
      }

      for (const request of [
        makeRequest('settings.getTerminalQuickCommands'),
        makeRequest('settings.updateTerminalQuickCommands', {
          mutation: { type: 'delete', id: 'other' }
        })
      ]) {
        const response = await dispatcher.dispatch(request, olderClient)
        expect(response).toMatchObject({
          ok: true,
          result: { terminalQuickCommands: supported ? commands : commands.slice(0, 40) }
        })
      }
    }
  )

  it('publishes every command and prompt to current clients and in-process callers', async () => {
    const commands = Array.from({ length: 100 }, (_, index) => ({
      ...longCommand,
      id: `command-${index}`
    }))
    const { dispatcher } = makeDispatcher(commands)
    for (const options of [
      {
        clientKind: 'runtime' as const,
        clientCapabilities: [
          TERMINAL_QUICK_COMMAND_LARGE_LISTS_RUNTIME_CAPABILITY,
          TERMINAL_QUICK_COMMAND_LONG_PROMPTS_RUNTIME_CAPABILITY
        ]
      },
      undefined
    ]) {
      const response = await dispatcher.dispatch(
        makeRequest('settings.getTerminalQuickCommands'),
        options
      )
      expect(response).toMatchObject({ ok: true, result: { terminalQuickCommands: commands } })
    }
  })
})
