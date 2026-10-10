/**
 * A desktop automation's run through `agent.launch` (`backgroundRun`): the host spawns the launch
 * the window would have spawned, through the window's own spawn, and records nothing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../../../../shared/tui-agent-startup'
import { tuiAgentToAgentKind } from '../../../../shared/agent-kind'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { installWindowPtySpawn } from '../../../ipc/pty/ipc/window-pty-spawn'
import type { RpcContext } from '../core'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore,
  STRUCTURED_PREFERENCE
} from './agent-launch.test-fixture'

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const LAUNCH_TOKEN = 'launch-token-1'
const OPERATION_ID = `${Date.now()}-${'0'.repeat(32)}`
const DESKTOP: Partial<RpcContext> = {
  caller: { kind: 'desktop' },
  clientKind: 'runtime',
  clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
}
// Longer than the typed-line budget and multi-line: main's window still put it on the command.
const LONG_PROMPT = `Summarize the repository.\n${'Check every file carefully. '.repeat(40)}`

function hostWith(settings: Partial<GlobalSettings> = {}) {
  const runtime = {
    ...runtimeStub({ settings: STRUCTURED_PREFERENCE }),
    preAllocateHandleForPty: vi.fn((ptyId: string) => `term_${ptyId}`)
  }
  const spawn = vi.fn(async (_args: Record<string, unknown>) => ({
    id: 'pty-9',
    incarnationId: 'inc-1'
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch reads only the settings keys a startup plan reads.
  installWindowPtySpawn({ spawn, getSettings: () => settings as GlobalSettings })
  return { runtime, spawn }
}

function backgroundRun(overrides: Record<string, unknown> = {}) {
  return {
    agent: 'claude',
    target: { kind: 'existing', worktree: 'id:wt-7' },
    prompt: { text: LONG_PROMPT, delivery: 'submit' },
    launchSource: 'unknown',
    paneKey: PANE_KEY,
    presentation: 'background',
    backgroundRun: {
      title: 'Nightly review',
      extraAgentArgs: '--effort high',
      launchToken: LAUNCH_TOKEN
    },
    ...overrides
  }
}

async function launch(
  params: unknown,
  runtime: ReturnType<typeof hostWith>['runtime'],
  context: Partial<RpcContext> = DESKTOP
) {
  const parsed = AGENT_LAUNCH.params.safeParse(params)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
  }
  return AGENT_LAUNCH.handler(parsed.data, rpcContext(runtime, context))
}

afterEach(() => {
  installWindowPtySpawn(null)
  setAgentLaunchRecordStore(null)
})

describe('a desktop automation run started by its host', () => {
  it("spawns exactly the window's launch, with the prompt on the command at any length", async () => {
    const { runtime, spawn } = hostWith({ agentDefaultArgs: { claude: '--model sonnet' } })

    const result = await launch(backgroundRun(), runtime)

    // Built as launch-agent-background-session.ts builds it for a local workspace.
    const plan = buildAgentStartupPlan({
      ...resolveAgentStartupPlanInputs({
        agent: 'claude',
        settings: { agentDefaultArgs: { claude: '--model sonnet' } },
        platform: process.platform,
        isRemote: false,
        extraAgentArgs: '--effort high'
      }),
      prompt: LONG_PROMPT,
      allowEmptyPromptLaunch: false
    })
    expect(plan?.launchCommand).toContain("'--effort' 'high'")
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]?.[0]).toEqual({
      cols: 120,
      rows: 40,
      cwd: '/tmp/wt-7',
      command: plan?.launchCommand,
      ...(plan?.startupCommandDelivery
        ? { startupCommandDelivery: plan.startupCommandDelivery }
        : {}),
      env: {
        ...plan?.env,
        ORCA_PANE_KEY: PANE_KEY,
        ORCA_TAB_ID: TAB_ID,
        ORCA_WORKTREE_ID: 'wt-7',
        ORCA_AGENT_LAUNCH_TOKEN: LAUNCH_TOKEN
      },
      launchConfig: plan?.launchConfig,
      launchToken: LAUNCH_TOKEN,
      launchAgent: 'claude',
      connectionId: null,
      worktreeId: 'wt-7',
      tabId: TAB_ID,
      leafId: LEAF_ID,
      placement: { kind: 'new-tab', row: { customTitle: 'Nightly review' } },
      telemetry: {
        agent_kind: tuiAgentToAgentKind('claude'),
        launch_source: 'unknown',
        request_kind: 'new'
      }
    })
    // Terminal-only although the chat default is on, and never revealed by the host.
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_pty-9', paneKey: PANE_KEY })
    expect(result.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })
    expect(result.backgroundRun).toEqual({ ptyId: 'pty-9', incarnationId: 'inc-1' })
  })

  it('launches although the launch-record store cannot open, which it never opens', async () => {
    const { runtime, spawn } = hostWith()
    runtime.openAgentSessionRecordStore.mockRejectedValue(new Error('disk full'))

    await launch(backgroundRun(), runtime)

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(runtime.openAgentSessionRecordStore).not.toHaveBeenCalled()
  })

  it('starts a post-start agent bare, leaving its prompt to the window', async () => {
    const { runtime, spawn } = hostWith()

    const { extraAgentArgs: _none, ...run } = backgroundRun().backgroundRun
    await launch(backgroundRun({ agent: 'aider', prompt: undefined, backgroundRun: run }), runtime)

    const plan = buildAgentStartupPlan({
      ...resolveAgentStartupPlanInputs({
        agent: 'aider',
        settings: {},
        platform: process.platform,
        isRemote: false
      }),
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ command: plan?.launchCommand })
  })

  it.each([
    [
      'another caller',
      backgroundRun(),
      { ...DESKTOP, caller: { kind: 'paired-device', deviceId: 'device-1' } }
    ],
    ['an operation id', backgroundRun({ operationId: OPERATION_ID }), DESKTOP]
  ] as const)('refuses as unavailable for %s, before any spawn', async (_name, params, context) => {
    const { runtime, spawn } = hostWith()

    await expect(launch(params, runtime, context)).rejects.toThrow(
      'agent_launch_background_run_unavailable'
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('never reads a run on a replayed launch', () => {
    const parsed = AGENT_LAUNCH_REPLAY.params.parse(backgroundRun({ operationId: OPERATION_ID }))

    expect(parsed).not.toHaveProperty('backgroundRun')
  })

  it('leaves an SSH workspace to the window', async () => {
    const { runtime, spawn } = hostWith()
    runtime.showTerminalWorkspaceLaunchScope.mockResolvedValue({
      id: 'wt-7',
      path: '/home/me/wt-7',
      connectionId: 'ssh-1',
      repo: null,
      folderWorkspace: null
    })

    await expect(launch(backgroundRun(), runtime)).rejects.toThrow(
      'agent_launch_background_run_unavailable'
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('answers unavailable when this host has no window spawn', async () => {
    const { runtime } = hostWith()
    installWindowPtySpawn(null)

    await expect(launch(backgroundRun(), runtime)).rejects.toThrow(
      'agent_launch_background_run_unavailable'
    )
  })

  it("reports a failed spawn as the spawn's own failure, never as unavailable", async () => {
    const { runtime, spawn } = hostWith()
    spawn.mockRejectedValue(new Error('posix_spawnp failed.'))

    const failure = await launch(backgroundRun(), runtime).catch((error: unknown) => error)

    expect(failure).toMatchObject({
      code: 'agent_launch_background_run_spawn_failed',
      message: 'Error: posix_spawnp failed.'
    })
  })
})
