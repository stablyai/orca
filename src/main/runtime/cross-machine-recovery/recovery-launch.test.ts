import { describe, expect, it, vi } from 'vitest'
import { MAX_RECOVERY_APPEND_SYSTEM_PROMPT_BYTES } from '../../../shared/cross-machine-recovery-launch'
import { CrossMachineRecoveryImportParams } from '../../../shared/rpc-contract/cross-machine-recovery-params'
import { buildAgentResumeStartupPlan } from '../../../shared/tui-agent-resume-startup'
import { createClaudeHelpFlagProbe } from './claude-help-flag-probe'
import { importRecoveryWorkspaceWithHost } from './recovery-import'
import { descriptor, fixture, SESSION_ID } from './recovery-import.test-fixture'

const CONTEXT = 'Recovered from laptop; $(do not run) this'

async function importAndResume(appendSystemPrompt: boolean) {
  const f = fixture({ appendSystemPrompt })
  await importRecoveryWorkspaceWithHost(
    f.host,
    {
      descriptor: descriptor(),
      checkoutPath: f.checkout,
      checkpointId: 'cp-1',
      recoveryLaunch: { [SESSION_ID]: { appendSystemPrompt: CONTEXT } },
      resume: [SESSION_ID]
    },
    f.readCommonDir
  )
  return f.ensureAgentSession.mock.calls[0]![0]
}

describe('recoveryLaunch', () => {
  it('appends --append-system-prompt as separate argv entries when claude advertises it', async () => {
    const request = await importAndResume(true)
    expect(request).toMatchObject({
      kind: 'explicit',
      agent: 'claude',
      extraResumeArgv: ['--append-system-prompt', CONTEXT]
    })
    expect(request).not.toHaveProperty('agentArgs')
  })

  it('launches a plain resume when the host claude does not advertise the flag', async () => {
    const request = await importAndResume(false)
    expect(request).not.toHaveProperty('extraResumeArgv')
  })

  it('quotes the appended text into the resume command instead of shell-parsing it', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession: { key: 'session_id', id: SESSION_ID },
      cmdOverrides: {},
      platform: 'darwin',
      extraResumeArgv: ['--append-system-prompt', CONTEXT]
    })
    expect(plan?.launchCommand).toContain(
      `'--resume' '${SESSION_ID}' '--append-system-prompt' '${CONTEXT}'`
    )
  })

  it.each([
    [MAX_RECOVERY_APPEND_SYSTEM_PROMPT_BYTES, true],
    [MAX_RECOVERY_APPEND_SYSTEM_PROMPT_BYTES + 1, false]
  ])('accepts an appendSystemPrompt of %i bytes: %s', (bytes, accepted) => {
    const parsed = CrossMachineRecoveryImportParams.safeParse({
      descriptor: {},
      checkoutPath: '/tmp/checkout',
      checkpointId: 'cp-1',
      recoveryLaunch: { [SESSION_ID]: { appendSystemPrompt: 'x'.repeat(bytes) } }
    })
    expect(parsed.success).toBe(accepted)
  })

  it.each([
    ['  --append-system-prompt <prompt>  Append a system prompt', true],
    ['  --system-prompt <prompt>  Replace the system prompt', false]
  ])('probes claude --help once: %s', async (stdout, advertised) => {
    const run = vi.fn(async () => ({
      code: 0,
      signal: null,
      stdout,
      stderr: '',
      timedOut: false
    }))
    const probe = createClaudeHelpFlagProbe('--append-system-prompt', run)
    expect(await probe()).toBe(advertised)
    expect(await probe()).toBe(advertised)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ program: 'claude', args: ['--help'] })
    )
  })
})
