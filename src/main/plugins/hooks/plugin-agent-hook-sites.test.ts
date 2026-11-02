import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginHookName } from '../../../shared/plugins/contributions/plugin-hook-contribution'
import { runPluginHookChain } from '../../../shared/plugins/workers/plugin-hook-chain'
import type { PluginHookChainOutcome } from '../../../shared/plugins/workers/plugin-hook-chain'
import { applyAgentLaunchPluginHook } from '../../ipc/pty/spawn-agent-launch-plugin-hook'
import {
  agentPromptHookApplies,
  runAgentPromptPluginHook
} from '../../runtime/terminal/input/terminal-send-plugin-hook'
import { PluginHookDeniedError, setPluginHookRunner } from './plugin-hook-dispatch'

type Decide = (event: PluginHookName, payload: unknown) => PluginHookChainOutcome

function installRunner(decide: Decide, wanted: readonly PluginHookName[]) {
  const run = vi.fn(async (event: PluginHookName, payload: unknown) => decide(event, payload))
  setPluginHookRunner({ wants: (event) => wanted.includes(event), run })
  return run
}

const rewrite =
  (changes: Record<string, unknown>): Decide =>
  (_event, payload) => ({ kind: 'continue', payload: { ...Object(payload), ...changes } })

afterEach(() => {
  setPluginHookRunner(null)
})

describe('agent.launch.before at the spawn', () => {
  const launch = {
    launchAgent: 'claude' as const,
    command: "claude 'fix the bug'",
    env: { ORCA_TERMINAL_HANDLE: 'h', PATH: '/bin' },
    worktreeId: 'folder:notes',
    preAllocatedHandle: 'term_1',
    cols: 80
  }

  it('shows the agent, workspace and command but never the environment, and applies changes', async () => {
    const run = installRunner(rewrite({ command: 'claude --verbose', env: { FOO: '1' } }), [
      'agent.launch.before'
    ])
    await expect(applyAgentLaunchPluginHook(launch)).resolves.toEqual({
      ...launch,
      command: 'claude --verbose',
      env: { ...launch.env, FOO: '1' }
    })
    expect(run).toHaveBeenCalledWith('agent.launch.before', {
      agent: 'claude',
      workspaceId: 'folder:notes',
      workspaceKind: 'folder',
      terminalId: 'term_1',
      command: "claude 'fix the bug'",
      env: {}
    })
  })

  it('leaves restores, resumes, shells and unhooked launches alone', async () => {
    const run = installRunner(rewrite({ command: 'x' }), ['agent.launch.before'])
    for (const args of [
      { ...launch, spawnIntent: 'automatic-restore' },
      { ...launch, resumeOrigin: 'saved' },
      { ...launch, resumeProviderSession: { id: 's' } },
      { ...launch, launchAgent: undefined }
    ]) {
      await expect(applyAgentLaunchPluginHook(args)).resolves.toBe(args)
    }
    expect(run).not.toHaveBeenCalled()
    setPluginHookRunner(null)
    await expect(applyAgentLaunchPluginHook(launch)).resolves.toBe(launch)
  })

  it('refuses the spawn on a deny', async () => {
    installRunner(
      () => ({ kind: 'deny', pluginKey: 'acme.policy', reason: 'no yolo' }),
      ['agent.launch.before']
    )
    await expect(applyAgentLaunchPluginHook(launch)).rejects.toBeInstanceOf(PluginHookDeniedError)
  })

  it('keeps Orca’s own variables out of a plugin’s reach', async () => {
    const outcome = await runPluginHookChain({
      event: 'agent.launch.before',
      payload: {
        agent: 'codex',
        workspaceId: null,
        workspaceKind: null,
        command: 'codex',
        env: {}
      },
      participants: ['acme.env'],
      invoke: async (_key, payload) => ({
        decision: 'continue',
        payload: { ...Object(payload), env: { ORCA_AGENT_LAUNCH_TOKEN: 'stolen' } }
      }),
      log: vi.fn(),
      now: () => 0
    })
    expect(outcome).toMatchObject({ kind: 'continue', payload: { env: {} } })
  })
})

describe('agent.prompt.before', () => {
  const allowed = vi.fn(async () => undefined)
  const input = {
    handle: 'term_1',
    prompt: 'fix it',
    inputKind: 'orchestration' as const,
    agent: 'codex'
  }

  it('rewrites the prompt with the agent named and rechecks the rewrite', async () => {
    const run = installRunner(rewrite({ prompt: 'be brief: fix it' }), ['agent.prompt.before'])
    await expect(runAgentPromptPluginHook(input, allowed)).resolves.toBe('be brief: fix it')
    expect(run).toHaveBeenCalledWith('agent.prompt.before', {
      agent: 'codex',
      terminalId: 'term_1',
      prompt: 'fix it',
      inputKind: 'orchestration'
    })
    expect(allowed).toHaveBeenCalledWith('be brief: fix it')
    const refuse = vi.fn(async () => {
      throw new Error('legacy writer refused')
    })
    await expect(runAgentPromptPluginHook(input, refuse)).rejects.toThrow('legacy writer refused')
  })

  it('denies, and never holds a person’s own prompt', async () => {
    installRunner(
      () => ({ kind: 'deny', pluginKey: 'acme.p', reason: 'secret' }),
      ['agent.prompt.before']
    )
    await expect(runAgentPromptPluginHook(input, allowed)).rejects.toThrow(
      'agent.prompt.before denied by plugin acme.p: secret'
    )
    expect(agentPromptHookApplies({})).toBe(true)
    expect(agentPromptHookApplies({ inputSource: 'programmatic' })).toBe(true)
    expect(agentPromptHookApplies({ inputSource: 'desktop' })).toBe(false)
    expect(agentPromptHookApplies({ inputSource: 'mobile' })).toBe(false)
    setPluginHookRunner(null)
    expect(agentPromptHookApplies({})).toBe(false)
  })
})
