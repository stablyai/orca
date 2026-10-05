import { describe, expect, it, vi } from 'vitest'
import type { AgentLaunchIntent } from '../../shared/agent-launch-intent'
import { executeAgentLaunch } from './agent-launch-executor'

function harness() {
  const readSettings = vi.fn(() => {
    throw new Error('settings_not_needed_for_refusal')
  })
  const createSupport = vi.fn(async () => {
    throw new Error('support_not_needed_for_refusal')
  })
  const createTerminal = vi.fn(async () => ({ handle: 'term_new' }))
  const deliverPrompt = vi.fn(async () => true)
  const createWorktree = vi.fn(async () => ({
    worktreeId: 'wt_new',
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
          getClientSettings: readSettings,
          getStructuredAgentSessionCreateSupport: createSupport
        },
        surfaces: {
          createTerminalAgent: createTerminal,
          createStructuredSession: async () => {
            throw new Error('structured_not_expected')
          },
          deliverTerminalPrompt: deliverPrompt
        },
        workspaces: { createWorktree }
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
  it.each([reused, creating])(
    'refuses before reading settings or creating or delivering',
    async (intent) => {
      const h = harness()
      await expect(h.run(intent)).rejects.toMatchObject({ code: 'capability_unsupported' })
      expect(h.readSettings).not.toHaveBeenCalled()
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
