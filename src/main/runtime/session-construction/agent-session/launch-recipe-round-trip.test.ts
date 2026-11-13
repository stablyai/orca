import { describe, expect, it } from 'vitest'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { resolveResumeLaunchRecipe } from '../../../../shared/agent-launch/choices/resume-launch-recipe'
import { buildAgentResumeStartupPlan } from '../../../../shared/agent-launch/startup/tui-agent-resume-startup'
import { buildAgentStartupPlan } from '../../../../shared/agent-launch/startup/tui-agent-startup'
import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { SessionOptionValue } from '../../../../shared/native-chat/input/native-chat-session-options'
import { sleepingAgentLaunchConfigSchema } from '../../../../shared/workspace-session/workspace-session-sleeping-agents'
import { parseDaemonLaunchNoteChange } from '../../../daemon/protocol/daemon-launch-note-protocol'
import { resolveSavedRestoreLaunchRecipe } from './saved-restore-launch-recipe'

type RoundTripCase = {
  agent: ResumableTuiAgent
  agentArgs: string
  sessionOptions: Record<string, SessionOptionValue>
  launch: string
  resume: string
}

// Claude's model and effort come back from its own session, so its resume carries neither flag.
const CASES: RoundTripCase[] = [
  {
    agent: 'claude',
    agentArgs: '--verbose',
    sessionOptions: { model: 'opus', effort: 'max', fastMode: true, permissionMode: 'full-access' },
    launch: `claude '--verbose' '--model' 'opus' '--effort' 'max' '--settings' '{"fastMode":true}' '--dangerously-skip-permissions'`,
    resume: `claude '--verbose' '--settings' '{"fastMode":true}' '--dangerously-skip-permissions' '--resume' 'S1'`
  },
  {
    agent: 'codex',
    agentArgs: '--search',
    sessionOptions: {
      model: 'gpt-5.6-terra',
      effort: 'xhigh',
      serviceTier: 'fast',
      permissionMode: 'full-access'
    },
    launch: `codex '-c' 'disable_paste_burst=true' '--search' '-m' 'gpt-5.6-terra' '-c' 'model_reasoning_effort=xhigh' '-c' 'service_tier=fast' '--dangerously-bypass-approvals-and-sandbox'`,
    resume: `codex '--search' '-m' 'gpt-5.6-terra' '-c' 'model_reasoning_effort=xhigh' '-c' 'service_tier=fast' '--dangerously-bypass-approvals-and-sandbox' '-c' 'disable_paste_burst=true' 'resume' 'S1'`
  },
  {
    agent: 'gemini',
    agentArgs: '--debug',
    sessionOptions: { model: 'gemini-2.5-pro', permissionMode: 'full-access' },
    launch: `gemini '--debug' '-m' 'gemini-2.5-pro' '--yolo'`,
    resume: `gemini '--debug' '-m' 'gemini-2.5-pro' '--yolo' '--resume' 'S1'`
  },
  {
    agent: 'cursor',
    agentArgs: '--debug',
    sessionOptions: { model: 'gpt-5', permissionMode: 'full-access' },
    launch: `cursor-agent '--debug' '--model' 'gpt-5' '--yolo'`,
    resume: `cursor-agent '--debug' '--model' 'gpt-5' '--yolo' '--resume' 'S1'`
  },
  {
    agent: 'grok',
    agentArgs: '--debug',
    sessionOptions: { model: 'grok-4', effort: 'high', permissionMode: 'full-access' },
    launch: `grok '--debug' '-m' 'grok-4' '--reasoning-effort' 'high' '--permission-mode' 'bypassPermissions'`,
    resume: `grok '--debug' '-m' 'grok-4' '--reasoning-effort' 'high' '--permission-mode' 'bypassPermissions' '--resume' 'S1'`
  }
]

const ENV = { ACCOUNT_REGION: 'eu' }

function providerSession(agent: TuiAgent): AgentProviderSessionMetadata {
  return { key: agent === 'cursor' ? 'conversation_id' : 'session_id', id: 'S1' }
}

function resume(agent: ResumableTuiAgent, recipe: SleepingAgentLaunchConfig) {
  return buildAgentResumeStartupPlan({
    agent,
    providerSession: providerSession(agent),
    cmdOverrides: {},
    platform: 'linux',
    shell: 'posix',
    ...recipe
  })
}

/** Every way a saved note reaches a resume: the workspace session, the daemon, and a host's saved restore. */
function restorePaths(
  agent: ResumableTuiAgent,
  saved: SleepingAgentLaunchConfig
): [string, SleepingAgentLaunchConfig][] {
  const persisted = sleepingAgentLaunchConfigSchema.parse(JSON.parse(JSON.stringify(saved)))!
  const daemon = parseDaemonLaunchNoteChange({ arm: { launchToken: 't', launchConfig: saved } })
  const session = providerSession(agent)
  return [
    [
      'window restore, sleep/wake, mobile, worker reopen',
      resolveResumeLaunchRecipe(persisted, agent, session)
    ],
    [
      'daemon launch note',
      resolveResumeLaunchRecipe(
        daemon && 'arm' in daemon ? daemon.arm.launchConfig : undefined,
        agent,
        session
      )
    ],
    [
      'host saved restore',
      resolveSavedRestoreLaunchRecipe({
        agent,
        providerSession: session,
        record: {
          paneKey: 'tab:1',
          worktreeId: 'w',
          agent,
          providerSession: session,
          prompt: '',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1,
          launchConfig: persisted
        },
        liveRow: undefined
      })
    ]
  ]
}

describe.each(CASES)(
  '$agent launch recipe',
  ({ agent, agentArgs, sessionOptions, launch, resume: expected }) => {
    const plan = buildAgentStartupPlan({
      agent,
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      agentArgs,
      agentEnv: ENV,
      sessionOptions,
      sessionOptionsOverrideAgentArgs: true
    })!

    it('launches with every choice', () => {
      expect(plan.launchCommand).toBe(launch)
    })

    it.each(restorePaths(agent, plan.launchConfig))('%s rebuilds it, twice', (_path, recipe) => {
      const first = resume(agent, recipe)!
      expect(first.launchCommand).toBe(expected)
      expect(first.env).toEqual(ENV)
      expect(
        resume(agent, resolveResumeLaunchRecipe(first.launchConfig, agent, null))!.launchCommand
      ).toBe(expected)
    })
  }
)

it('replays a note saved before launch choices were recorded exactly as before', () => {
  const old = { agentCommand: "codex '--search'", agentArgs: "'--search'", agentEnv: {} }
  expect(resume('codex', resolveResumeLaunchRecipe(old, 'codex', null))!.launchCommand).toBe(
    "codex '--search' '-c' 'disable_paste_burst=true' 'resume' 'S1'"
  )
})
