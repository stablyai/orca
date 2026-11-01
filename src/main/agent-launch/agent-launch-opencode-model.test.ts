import { describe, expect, it, vi } from 'vitest'
import recordings from '../../shared/fixtures/source-control-launch-recordings.json'
import type { AgentLaunchIntent } from '../../shared/agent-launch-intent'
import { executeAgentLaunch } from './agent-launch-executor'
import { toAgentLaunchPreferences } from '../../shared/agent-launch-preferences'
import { assertOpenCodeModelLaunchPreferencesAbsent } from '../opencode/opencode-model-startup-plan'
import { agentPermissionChoices } from '../../shared/tui-agent-permission-choice'

function harness() {
  const readSettings = vi.fn(() => {
    throw new Error('settings_unavailable')
  })
  const createSupport = vi.fn(async () => {
    throw new Error('support_not_needed_for_refusal')
  })
  const createTerminal = vi.fn(async () => ({ handle: 'term_new' }))
  const deliverPrompt = vi.fn(async () => true)
  const createWorktree = vi.fn(async () => ({
    worktreeId: 'wt_new',
    connectionId: null,
    startupTerminalHandle: 'term_new'
  }))
  return {
    readSettings,
    createTerminal,
    deliverPrompt,
    createWorktree,
    run: (intent: AgentLaunchIntent) =>
      executeAgentLaunch({
        intent,
        runtime: {
          requireStore: () => ({ getSettings: readSettings }),
          getStructuredAgentSessionCreateSupport: createSupport
        },
        surfaces: {
          createTerminalAgent: createTerminal,
          createStructuredSession: async () => {
            throw new Error('structured_not_expected')
          },
          deliverTerminalPrompt: deliverPrompt
        },
        workspaces: {
          createWorktree,
          createFolderWorkspace: async () => {
            throw new Error('folder_create_not_expected')
          }
        }
      })
  }
}

const reused: AgentLaunchIntent = {
  agent: 'opencode',
  target: { kind: 'existing', worktree: 'folder:private' },
  reuseTerminal: { handle: 'term_existing' },
  prompt: { text: 'Read only', delivery: 'submit' },
  sessionOptions: { model: 'private-proof/model-b' }
}
const creating: AgentLaunchIntent = {
  ...reused,
  reuseTerminal: undefined,
  target: { kind: 'create-worktree', create: { repo: 'id:private', name: 'task' } }
}

describe('OpenCode model preferences on unsupported launch placements', () => {
  it('keeps own selectable without projecting a meaningless permission into either terminal guard', async () => {
    const sessionOptions = { permissionMode: 'own' }
    const projected = toAgentLaunchPreferences(sessionOptions, 'opencode')
    expect(agentPermissionChoices('opencode')).toContain('own')
    expect(projected).toBeUndefined()
    // Workspace creation consumes this projection through the same unchanged broad guard.
    expect(() => assertOpenCodeModelLaunchPreferencesAbsent('opencode', projected)).not.toThrow()
    for (const intent of [reused, creating]) {
      const h = harness()
      await expect(h.run({ ...intent, sessionOptions })).resolves.toBeDefined()
    }
  })

  it('refuses the real OpenCode model readback on a reused terminal before prompt delivery', async () => {
    const model = recordings.opencode.update.message.params.update.configOptions.find(
      (option) => option.category === 'model'
    )?.currentValue
    expect(model).toBe('opencode/big-pickle')
    const h = harness()
    await expect(h.run({ ...reused, sessionOptions: { model } })).rejects.toMatchObject({
      code: 'capability_unsupported'
    })
    expect(h.createTerminal).not.toHaveBeenCalled()
    expect(h.createWorktree).not.toHaveBeenCalled()
    expect(h.deliverPrompt).not.toHaveBeenCalled()
  })

  it.each([reused, creating])(
    'preserves definitive refusal without creating or delivering when the route settings read throws',
    async (intent) => {
      const h = harness()
      await expect(h.run(intent)).rejects.toMatchObject({ code: 'capability_unsupported' })
      expect(h.readSettings).toHaveBeenCalledOnce()
      expect(h.createTerminal).not.toHaveBeenCalled()
      expect(h.createWorktree).not.toHaveBeenCalled()
      expect(h.deliverPrompt).not.toHaveBeenCalled()
    }
  )

  it('preserves prompt delivery to a reused terminal without model preferences', async () => {
    const h = harness()
    expect((await h.run({ ...reused, sessionOptions: undefined })).outcome).toEqual({
      kind: 'terminal',
      handle: 'term_existing'
    })
    expect(h.deliverPrompt).toHaveBeenCalledOnce()
    expect(h.createWorktree).not.toHaveBeenCalled()
  })

  it('preserves ordinary worktree creation without model preferences', async () => {
    const h = harness()
    expect((await h.run({ ...creating, sessionOptions: undefined })).worktreeId).toBe('wt_new')
    expect(h.createWorktree).toHaveBeenCalledOnce()
  })
})
