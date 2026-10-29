import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  getDefaultSourceControlAiSettings,
  resolveSourceControlActionRecipe
} from '../../../src/shared/source-control-ai'
import { buildAgentStartupPlan } from '../../../src/shared/tui-agent-startup'
import { resolveAgentStartupPlanInputs } from '../../../src/shared/agent-startup-plan-inputs'
import { toAgentLaunchPreferences } from '../../../src/shared/agent-launch-preferences'
import { AgentLaunchReplay } from '../../../src/shared/rpc-contract/agent-launch-params'
import { AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE } from './mobile-existing-agent-launch'
import {
  AGENT_PROMPT_NOT_SENT_MESSAGE,
  agentStartedMessage,
  launchAgentWithPrompt,
  promptedLaunchNotice
} from './pr-ai-triage-launch'

function requestPortRpcClient(sendRequest: RpcClient['sendRequest']): RpcClient {
  return {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

const LAUNCH_CAPABILITIES = [
  'agent.launch.v2',
  'agent.launch.replay.v1',
  'agent.launch.replay-required.v1'
]
const RECEIPT = {
  mode: 'terminal',
  preferred: 'terminal',
  reason: 'user_default',
  detail: 'Started a terminal agent.'
}

function ok(result: unknown): RpcResponse {
  return { id: 'x', ok: true, result, _meta: { runtimeId: 'r' } }
}

// Answers by method so the order of the agent loader's reads doesn't matter.
function hostClient(replies: {
  settings?: unknown
  repo?: unknown
  detected?: unknown[]
  launch?: RpcResponse
}) {
  const sendRequest = vi.fn(async (method: string, _params?: unknown) => {
    if (method === 'repo.list') {
      return ok({ repos: [replies.repo ?? { id: 'repo-1' }] })
    }
    if (method === 'settings.get') {
      return ok({ settings: replies.settings ?? {} })
    }
    if (method === 'preflight.detectAgents') {
      return ok(replies.detected ?? ['claude', 'codex'])
    }
    if (method === 'agent.launchReplay') {
      return replies.launch ?? ok({})
    }
    throw new Error(`unexpected ${method}`)
  })
  return { client: requestPortRpcClient(sendRequest), sendRequest }
}

function launchedWith(prompt: unknown, warning?: string): RpcResponse {
  return ok({
    outcome: { kind: 'terminal', handle: 'term-1' },
    worktreeId: 'repo-1::/w',
    receipt: RECEIPT,
    ...(prompt ? { prompt } : {}),
    ...(warning ? { warning } : {})
  })
}

function run(client: RpcClient, hostCapabilities: readonly string[] = LAUNCH_CAPABILITIES) {
  return launchAgentWithPrompt({
    client,
    hostCapabilities,
    worktreeId: 'repo-1::/w',
    actionId: 'fixChecks',
    prompt: 'Fix the failing checks',
    launchSource: 'task_page'
  })
}

function launchParams(sendRequest: ReturnType<typeof hostClient>['sendRequest']) {
  return sendRequest.mock.calls.find(([method]) => method === 'agent.launchReplay')?.[1]
}

describe('launchAgentWithPrompt', () => {
  it('never creates a bare shell: an older host gets update copy and no request', async () => {
    const { client, sendRequest } = hostClient({})
    await expect(run(client, [])).resolves.toEqual({
      kind: 'not-started',
      message: AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE
    })
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('starts the default agent with the prompt through the host', async () => {
    const { client, sendRequest } = hostClient({
      settings: { defaultTuiAgent: 'codex' },
      launch: launchedWith({ delivery: 'submit', outcome: 'handed-to-terminal' })
    })
    await expect(run(client)).resolves.toEqual({ kind: 'sent' })
    expect(launchParams(sendRequest)).toMatchObject({
      agent: 'codex',
      target: { kind: 'existing', worktree: 'id:repo-1::/w' },
      prompt: { text: 'Fix the failing checks', delivery: 'submit' },
      launchSource: 'task_page'
    })
    expect(launchParams(sendRequest)).not.toHaveProperty('agentArgs')
    expect(sendRequest.mock.calls.some(([method]) => method === 'terminal.send')).toBe(false)
    expect(
      sendRequest.mock.calls.some(([method]) => method === 'session.tabs.createTerminal')
    ).toBe(false)
  })

  it("honours the action's saved agent over the default", async () => {
    const { client, sendRequest } = hostClient({
      settings: {
        defaultTuiAgent: 'codex',
        sourceControlAi: { actions: { fixChecks: { agentId: 'claude' } } }
      },
      launch: launchedWith({ delivery: 'submit', outcome: 'handed-to-terminal' })
    })
    await run(client)
    expect(launchParams(sendRequest)).toMatchObject({ agent: 'claude' })
  })

  it("wraps the prompt in the action's saved template, as the desktop does", async () => {
    const { client, sendRequest } = hostClient({
      settings: {
        defaultTuiAgent: 'claude',
        sourceControlAi: {
          actions: { fixChecks: { commandInputTemplate: '/review first\n\n{basePrompt}' } }
        }
      },
      launch: launchedWith({ delivery: 'submit', outcome: 'handed-to-terminal' })
    })
    await run(client)
    expect(launchParams(sendRequest)).toMatchObject({
      prompt: { text: '/review first\n\nFix the failing checks', delivery: 'submit' }
    })
  })

  it('refuses to launch with an empty saved template rather than send no prompt', async () => {
    const { client, sendRequest } = hostClient({
      settings: {
        defaultTuiAgent: 'claude',
        sourceControlAi: { actions: { fixChecks: { commandInputTemplate: '   ' } } }
      }
    })
    await expect(run(client)).resolves.toMatchObject({ kind: 'not-started' })
    expect(launchParams(sendRequest)).toBeUndefined()
  })

  it('falls back to the default agent on an older host that publishes no recipes', async () => {
    const { client, sendRequest } = hostClient({
      // A host before the recipe projection: settings.get carries no sourceControlAi at all.
      settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] },
      launch: launchedWith({ delivery: 'submit', outcome: 'handed-to-terminal' })
    })
    await expect(run(client)).resolves.toEqual({ kind: 'sent' })
    expect(launchParams(sendRequest)).toMatchObject({
      agent: 'codex',
      prompt: { text: 'Fix the failing checks' }
    })
  })

  it("forwards the action's saved terminal arguments", async () => {
    const { client, sendRequest } = hostClient({
      settings: {
        defaultTuiAgent: 'claude',
        sourceControlAi: { actions: { fixChecks: { agentArgs: '--model opus' } } }
      },
      launch: launchedWith({ delivery: 'submit', outcome: 'handed-to-terminal' })
    })
    await run(client)
    expect(launchParams(sendRequest)).toMatchObject({ agent: 'claude' })
    expect(launchParams(sendRequest)).toHaveProperty('agentArgs', '--model opus')
  })

  it('keeps inherited phone options without raw conflicts when the workspace shell is unknown', async () => {
    const settings = {
      defaultTuiAgent: 'codex' as const,
      sourceControlAi: {
        ...getDefaultSourceControlAiSettings(),
        actions: {
          fixChecks: {
            agentId: 'codex' as const,
            surface: 'terminal' as const,
            launchPreferences: { agentId: 'codex' as const, model: 'gpt-5.4' }
          }
        }
      }
    }
    const repo = {
      id: 'repo-1',
      sourceControlAi: {
        actionOverrides: { fixChecks: { agentArgs: '--model gpt-5.3-codex' } }
      }
    }
    expect(
      resolveSourceControlActionRecipe({ settings, repo, actionId: 'fixChecks' })
    ).toMatchObject({ launchPreferencesYieldToAgentArgs: true })
    const { client, sendRequest } = hostClient({
      settings,
      repo,
      launch: launchedWith({ delivery: 'submit', outcome: 'handed-to-terminal' })
    })
    const capabilities = [...LAUNCH_CAPABILITIES, 'agent.launch.chat-options.v1']
    await expect(run(client, [...capabilities, 'agent.launch.surface.v1'])).resolves.toEqual({
      kind: 'sent'
    })
    const params = AgentLaunchReplay.parse(launchParams(sendRequest))
    expect(params).toMatchObject({ surface: 'terminal', chatOptions: { model: 'gpt-5.4' } })
    expect(params).not.toHaveProperty('agentArgs')
    const preferences = toAgentLaunchPreferences(params.chatOptions, params.agent)
    const startup = buildAgentStartupPlan({
      ...resolveAgentStartupPlanInputs({
        agent: params.agent,
        settings: {},
        platform: 'linux',
        isRemote: false,
        shell: 'posix',
        agentArgs: params.agentArgs,
        sessionOptions: preferences?.model ? { model: preferences.model } : undefined
      }),
      prompt: params.prompt?.text ?? ''
    })
    expect(startup?.launchCommand).toContain('gpt-5.4')
    expect(startup?.launchCommand).not.toContain('gpt-5.3-codex')

    sendRequest.mockClear()
    await expect(run(client, capabilities)).resolves.toEqual({ kind: 'sent' })
    const olderHostParams = AgentLaunchReplay.parse(launchParams(sendRequest))
    expect(olderHostParams).not.toHaveProperty('surface')
    expect(olderHostParams).not.toHaveProperty('agentArgs')
    expect(olderHostParams.chatOptions).toEqual(params.chatOptions)
  })

  it('refuses rather than swaps when the saved agent is not on this host', async () => {
    const { client, sendRequest } = hostClient({
      settings: { sourceControlAi: { actions: { fixChecks: { agentId: 'gemini' } } } },
      detected: ['claude']
    })
    await expect(run(client)).resolves.toEqual({
      kind: 'not-started',
      message: 'The saved agent for this action is not available on this workspace host.'
    })
    expect(launchParams(sendRequest)).toBeUndefined()
  })

  it('still launches an agent when the default is a blank terminal', async () => {
    const { client, sendRequest } = hostClient({
      settings: { defaultTuiAgent: 'blank' },
      detected: ['codex', 'claude'],
      launch: launchedWith({ delivery: 'submit', outcome: 'handed-to-terminal' })
    })
    await run(client)
    expect(launchParams(sendRequest)).toMatchObject({ agent: 'claude' })
  })

  it('reports no agent when none is detected and enabled', async () => {
    const { client } = hostClient({
      settings: { disabledTuiAgents: ['claude'] },
      detected: ['claude']
    })
    await expect(run(client)).resolves.toEqual({
      kind: 'not-started',
      message: 'No enabled AI agent was detected on this workspace host.'
    })
  })

  it('reports prompt-not-sent when the agent started without its prompt (v1.4.206-207 hosts)', async () => {
    const { client } = hostClient({
      launch: launchedWith({ delivery: 'submit', outcome: 'not-delivered' })
    })
    await expect(run(client)).resolves.toEqual({
      kind: 'prompt-not-sent',
      prompt: 'Fix the failing checks'
    })
  })

  it('passes the host warning through', async () => {
    const { client } = hostClient({
      launch: launchedWith(
        { delivery: 'submit', outcome: 'journaled', messageId: 'm' },
        '  launch arguments were ignored  '
      )
    })
    await expect(run(client)).resolves.toEqual({
      kind: 'sent',
      warning: 'launch arguments were ignored'
    })
  })

  it('reports an unknown outcome as unconfirmed', async () => {
    const { client } = hostClient({
      launch: {
        id: 'x',
        ok: false,
        error: {
          code: 'agent_session_operation_unknown',
          message: 'agent_session_operation_unknown'
        },
        _meta: { runtimeId: 'r' }
      }
    })
    await expect(run(client)).resolves.toMatchObject({ kind: 'unconfirmed' })
  })
})

describe('promptedLaunchNotice', () => {
  it('keeps the prompt only when the agent started without it', () => {
    expect(promptedLaunchNotice({ kind: 'prompt-not-sent', prompt: 'p' })).toEqual({
      succeeded: false,
      success: null,
      error: AGENT_PROMPT_NOT_SENT_MESSAGE,
      warning: null,
      undeliveredPrompt: 'p'
    })
    expect(promptedLaunchNotice({ kind: 'sent' })).toEqual({
      succeeded: true,
      success: 'Agent started',
      error: null,
      warning: null,
      undeliveredPrompt: null
    })
    expect(promptedLaunchNotice({ kind: 'unconfirmed', message: 'm' })).toEqual({
      succeeded: false,
      success: null,
      error: 'm',
      warning: null,
      undeliveredPrompt: null
    })
  })

  it('never reports the host warning on a launch that went ahead as an error', () => {
    expect(promptedLaunchNotice({ kind: 'sent', warning: 'arguments were ignored' })).toEqual({
      succeeded: true,
      success: 'Agent started',
      error: null,
      warning: 'arguments were ignored',
      undeliveredPrompt: null
    })
    expect(
      promptedLaunchNotice({
        kind: 'prompt-not-sent',
        prompt: 'p',
        warning: 'arguments were ignored'
      })
    ).toEqual({
      succeeded: false,
      success: null,
      error: AGENT_PROMPT_NOT_SENT_MESSAGE,
      warning: 'arguments were ignored',
      undeliveredPrompt: 'p'
    })
  })
})

describe('agentStartedMessage', () => {
  it('names the workspace the agent started in', () => {
    expect(promptedLaunchNotice({ kind: 'sent' }, 'feature-login').success).toBe(
      'Agent started in feature-login'
    )
  })

  it('still confirms the launch when the screen knows no workspace name', () => {
    expect(agentStartedMessage(null)).toBe('Agent started')
    expect(agentStartedMessage('   ')).toBe('Agent started')
  })
})

it.each([undefined, '', '--add-dir /extra'])(
  'forwards saved argument presence (%s) and capability-gated surface without changing warning success',
  async (agentArgs) => {
    for (const surface of [undefined, 'chat', 'terminal'] as const) {
      for (const capable of [false, true]) {
        const { client, sendRequest } = hostClient({
          settings: {
            defaultTuiAgent: 'codex',
            sourceControlAi: {
              actions: {
                fixChecks: {
                  agentId: 'codex',
                  surface,
                  ...(agentArgs !== undefined ? { agentArgs } : {})
                }
              }
            }
          },
          launch: launchedWith(
            { delivery: 'submit', outcome: 'handed-to-terminal' },
            'The host ignored terminal-only arguments.'
          )
        })
        const result = await run(client, [
          ...LAUNCH_CAPABILITIES,
          ...(capable ? ['agent.launch.surface.v1'] : [])
        ])
        expect(result).toEqual({
          kind: 'sent',
          warning: 'The host ignored terminal-only arguments.'
        })
        const params = launchParams(sendRequest)
        if (agentArgs === undefined) {
          expect(params).not.toHaveProperty('agentArgs')
        } else {
          expect(params).toHaveProperty('agentArgs', agentArgs)
        }
        if (surface === 'terminal' && capable) {
          expect(params).toHaveProperty('surface', 'terminal')
        } else {
          expect(params).not.toHaveProperty('surface')
        }
        expect(promptedLaunchNotice(result).succeeded).toBe(true)
      }
    }
  }
)
