import { describe, expect, it, vi } from 'vitest'
import {
  claudeBuildPermissionMode,
  leaveClaudePlanModeOnApproval
} from './claude-plan-approval-mode'
import {
  claimClaudePermissionModeRequest,
  observeClaudeRootInit,
  setClaudeAllowedPermissionMode
} from './claude-permission-mode-ladder'
import { claudeOwesFullAccessFallback } from './claude-full-access-refusal'
import { ClaudeControlRequestTimeoutError } from '../../sdk-transport/claude-agent-sdk-control-requests'

const BYPASS_REFUSAL =
  'Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration'
const AUTO_REFUSAL = 'Cannot set permission mode to auto: auto mode disabled by settings'

/** A Claude that refuses the given modes the way the CLI does. */
function claude(refuses: string[]) {
  return vi.fn((mode: string) =>
    refuses.includes(mode)
      ? Promise.reject(new Error(mode === 'auto' ? AUTO_REFUSAL : BYPASS_REFUSAL))
      : Promise.resolve()
  )
}

/** A Claude that refuses auto for a reason that can pass, until it is available. */
function autoForNow() {
  const auto = {
    available: false,
    setPermissionMode: vi.fn((mode: string) =>
      mode === 'auto' && !auto.available
        ? Promise.reject(
            new Error(
              'Cannot set permission mode to auto: auto mode is not available for this model',
              {
                cause: { errorCode: 'auto_mode_model' }
              }
            )
          )
        : Promise.resolve()
    )
  }
  return auto
}

/** A send's build switch, as the chat's message options apply it. */
async function send(
  session: Parameters<typeof claudeBuildPermissionMode>[0] &
    Parameters<typeof setClaudeAllowedPermissionMode>[0]
): Promise<string> {
  const mode = await setClaudeAllowedPermissionMode(session, claudeBuildPermissionMode(session))
  session.appliedInputOptions.set('buildPermissionMode', mode)
  return mode
}

async function approvePlan(
  facts: { launched: string; opened: string; bypassDisabled?: boolean; autoDisabled?: boolean },
  refuses: string[] = []
): Promise<{ applied: string | undefined; written: string[] }> {
  const setPermissionMode = claude(refuses)
  const appliedInputOptions = new Map<string, string>()
  leaveClaudePlanModeOnApproval(
    {
      launchIntent: { permissionMode: facts.launched },
      firstRootInit: { permissionMode: facts.opened },
      ...(facts.bypassDisabled === undefined ? {} : { bypassDisabled: facts.bypassDisabled }),
      ...(facts.autoDisabled === undefined ? {} : { autoDisabled: facts.autoDisabled }),
      reportedOptions: { reportedPermissionMode: 'plan' },
      appliedInputOptions,
      connection: { setPermissionMode }
    },
    { toolName: 'ExitPlanMode' },
    { behavior: 'allow', updatedInput: {} }
  )
  await vi.waitFor(() => expect(appliedInputOptions.has('buildPermissionMode')).toBe(true))
  return {
    applied: appliedInputOptions.get('buildPermissionMode'),
    written: setPermissionMode.mock.calls.map(([mode]) => mode)
  }
}

describe('leaving Plan mode after an approved plan', () => {
  it('builds in Approve for me when Claude refused Full access at start', async () => {
    const result = await approvePlan({ launched: 'bypassPermissions', opened: 'default' })
    expect(result).toEqual({ applied: 'auto', written: ['default', 'auto'] })
  })

  it('builds in Ask when Claude turns auto mode off too', async () => {
    expect(
      await approvePlan(
        { launched: 'bypassPermissions', opened: 'plan', bypassDisabled: true, autoDisabled: true },
        ['bypassPermissions', 'auto']
      )
    ).toEqual({ applied: 'default', written: ['default'] })
    expect(
      await approvePlan({ launched: 'bypassPermissions', opened: 'default' }, ['auto'])
    ).toEqual({ applied: 'default', written: ['default', 'auto'] })
  })

  it('ends in the best mode Claude accepts when no settings read said what it allows', async () => {
    expect(
      await approvePlan({ launched: 'bypassPermissions', opened: 'plan' }, ['bypassPermissions'])
    ).toEqual({ applied: 'auto', written: ['default', 'auto', 'bypassPermissions'] })
    expect(await approvePlan({ launched: 'bypassPermissions', opened: 'plan' })).toEqual({
      applied: 'bypassPermissions',
      written: ['default', 'auto', 'bypassPermissions']
    })
  })

  it('restores Full access where Claude allows it', async () => {
    expect(
      await approvePlan({ launched: 'bypassPermissions', opened: 'bypassPermissions' })
    ).toEqual({ applied: 'bypassPermissions', written: ['bypassPermissions'] })
  })

  it('restores the requested mode over a start that was not a Full access refusal', async () => {
    expect(await approvePlan({ launched: 'acceptEdits', opened: 'default' })).toEqual({
      applied: 'acceptEdits',
      written: ['acceptEdits']
    })
  })

  it('asks once when Claude accepts bypass after a Plan start no settings read covered', async () => {
    const setPermissionMode = claude([])
    const session = {
      launchIntent: { permissionMode: 'bypassPermissions' },
      firstRootInit: { permissionMode: 'plan' },
      connection: { setPermissionMode }
    }
    await setClaudeAllowedPermissionMode(session, 'bypassPermissions')
    await setClaudeAllowedPermissionMode(session, 'bypassPermissions')
    expect(setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
      'default',
      'auto',
      'bypassPermissions',
      'bypassPermissions'
    ])
  })

  it('falls back when Claude starts refusing bypass it allowed earlier', async () => {
    const refuses: string[] = []
    const setPermissionMode = claude(refuses)
    const session = {
      launchIntent: { permissionMode: 'bypassPermissions' },
      firstRootInit: { permissionMode: 'bypassPermissions' },
      connection: { setPermissionMode }
    }
    expect(await setClaudeAllowedPermissionMode(session, 'bypassPermissions')).toBe(
      'bypassPermissions'
    )
    refuses.push('bypassPermissions')
    expect(await setClaudeAllowedPermissionMode(session, 'bypassPermissions')).toBe('auto')
    expect(await setClaudeAllowedPermissionMode(session, 'bypassPermissions')).toBe('auto')
  })

  it('leaves the mode to a newer request that went out before Claude refused', async () => {
    const session: Parameters<typeof setClaudeAllowedPermissionMode>[0] = {
      launchIntent: { permissionMode: 'bypassPermissions' },
      firstRootInit: { permissionMode: 'bypassPermissions' },
      connection: {
        setPermissionMode: vi.fn((mode: string) => {
          // The user switches to Plan while Claude's answer is on its way.
          claimClaudePermissionModeRequest(session)
          return mode === 'bypassPermissions'
            ? Promise.reject(new Error(BYPASS_REFUSAL))
            : Promise.resolve()
        })
      }
    }
    await expect(setClaudeAllowedPermissionMode(session, 'bypassPermissions')).rejects.toThrow(
      BYPASS_REFUSAL
    )
    expect(vi.mocked(session.connection.setPermissionMode).mock.calls).toEqual([
      ['bypassPermissions', undefined]
    ])
  })

  it('stops when Claude refuses bypass for a chat that never asked for Full access', async () => {
    const setPermissionMode = claude(['bypassPermissions'])
    const session = {
      launchIntent: {},
      firstRootInit: { permissionMode: 'bypassPermissions' },
      connection: { setPermissionMode }
    }
    await expect(setClaudeAllowedPermissionMode(session, 'bypassPermissions')).rejects.toThrow(
      BYPASS_REFUSAL
    )
    expect(setPermissionMode).toHaveBeenCalledTimes(1)
  })

  it('asks for auto again once the model Claude refused it for changes', async () => {
    const auto = autoForNow()
    const session = {
      launchIntent: { permissionMode: 'bypassPermissions' },
      firstRootInit: { permissionMode: 'default' },
      bypassDisabled: true,
      appliedInputOptions: new Map<string, string>([['model', 'small']]),
      connection: { setPermissionMode: auto.setPermissionMode }
    }
    expect(await send(session)).toBe('default')
    expect(await send(session)).toBe('default')
    auto.available = true
    session.appliedInputOptions.set('model', 'large')
    expect(await send(session)).toBe('auto')
    expect(auto.setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
      'default',
      'auto',
      'default',
      'default',
      'auto'
    ])
  })

  it('opens the fallback with Ask, so a refusal of auto for now needs no later write', async () => {
    const auto = autoForNow()
    const session = {
      launchIntent: { permissionMode: 'bypassPermissions' },
      firstRootInit: { permissionMode: 'default' },
      bypassDisabled: true,
      autoDisabled: false,
      connection: { setPermissionMode: auto.setPermissionMode }
    }
    expect(await setClaudeAllowedPermissionMode(session, 'bypassPermissions')).toBe('default')
    expect(auto.setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual(['default', 'auto'])
  })

  it('takes the mode Claude accepted after an earlier switch went unanswered', async () => {
    const setPermissionMode = vi.fn((mode: string) =>
      mode === 'default'
        ? Promise.reject(new ClaudeControlRequestTimeoutError('set_permission_mode'))
        : Promise.resolve()
    )
    const session = {
      launchIntent: { permissionMode: 'bypassPermissions' },
      firstRootInit: { permissionMode: 'default' },
      bypassDisabled: true,
      connection: { setPermissionMode }
    }
    expect(await setClaudeAllowedPermissionMode(session, 'bypassPermissions')).toBe('auto')
  })

  it('falls back when Claude can not run Full access in this session', async () => {
    for (const [code, message] of [
      ['bypass_restricted', 'bypassPermissions not supported in restricted mode'],
      [
        'bypass_not_launched',
        'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions'
      ]
    ]) {
      const setPermissionMode = vi.fn((mode: string) =>
        mode === 'bypassPermissions'
          ? Promise.reject(new Error(message, { cause: { errorCode: code } }))
          : Promise.resolve()
      )
      const session = {
        launchIntent: { permissionMode: 'bypassPermissions' },
        firstRootInit: { permissionMode: 'bypassPermissions' },
        connection: { setPermissionMode }
      }
      expect(await setClaudeAllowedPermissionMode(session, 'bypassPermissions')).toBe('auto')
    }
  })

  it('records no fallback when the auto switch goes unanswered, and asks again next send', async () => {
    let answered = false
    const setPermissionMode = vi.fn((mode: string) =>
      mode === 'auto' && !answered
        ? Promise.reject(new ClaudeControlRequestTimeoutError('set_permission_mode'))
        : Promise.resolve()
    )
    const session = {
      launchIntent: { permissionMode: 'bypassPermissions' },
      firstRootInit: { permissionMode: 'default' },
      bypassDisabled: true,
      appliedInputOptions: new Map<string, string>(),
      connection: { setPermissionMode }
    }
    await expect(send(session)).rejects.toThrow('timed out')
    expect(session.appliedInputOptions.has('buildPermissionMode')).toBe(false)
    answered = true
    // Asked again after a short pause, not on every input.
    expect(await send(session)).toBe('default')
    vi.setSystemTime(Date.now() + 10_000)
    try {
      expect(await send(session)).toBe('auto')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the mode unknown when the Approve for me switch never reached Claude', async () => {
    const setPermissionMode = vi.fn((mode: string) =>
      mode === 'auto'
        ? Promise.reject(
            new Error('write EPIPE', { cause: { errorClass: 'transport', message: 'EPIPE' } })
          )
        : Promise.resolve()
    )
    const session = {
      launchIntent: { permissionMode: 'bypassPermissions' },
      firstRootInit: { permissionMode: 'default' },
      bypassDisabled: true,
      appliedInputOptions: new Map<string, string>(),
      connection: { setPermissionMode }
    }
    await expect(send(session)).rejects.toThrow('write EPIPE')
    expect(session.appliedInputOptions.has('buildPermissionMode')).toBe(false)
  })

  it('switches to the fallback during the turn whose start shows Claude left Full access', async () => {
    const setPermissionMode = claude([])
    const session = {
      launchIntent: { permissionMode: 'bypassPermissions' },
      bypassDisabled: false,
      appliedInputOptions: new Map<string, string>(),
      reportedOptions: {},
      connection: { setPermissionMode }
    }
    observeClaudeRootInit(session, { permissionMode: 'default' })
    await vi.waitFor(() =>
      expect(session.appliedInputOptions.get('buildPermissionMode')).toBe('auto')
    )
    expect(setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual(['default', 'auto'])
  })

  it('leaves Plan when Claude accepted Ask before the Approve for me switch went unanswered', async () => {
    const setPermissionMode = vi.fn((mode: string) =>
      mode === 'auto'
        ? Promise.reject(new ClaudeControlRequestTimeoutError('set_permission_mode'))
        : Promise.resolve()
    )
    const appliedInputOptions = new Map<string, string>([
      ['interactionMode', 'plan'],
      ['buildPermissionMode', 'auto']
    ])
    leaveClaudePlanModeOnApproval(
      {
        launchIntent: { permissionMode: 'bypassPermissions' },
        firstRootInit: { permissionMode: 'default' },
        bypassDisabled: true,
        reportedOptions: { reportedPermissionMode: 'plan' },
        appliedInputOptions,
        connection: { setPermissionMode }
      },
      { toolName: 'ExitPlanMode' },
      { behavior: 'allow', updatedInput: {} }
    )
    await vi.waitFor(() => expect(appliedInputOptions.get('interactionMode')).toBe('default'))
    expect(appliedInputOptions.has('buildPermissionMode')).toBe(false)
  })

  it('falls back when Claude started outside Full access though its settings read allowed it', async () => {
    const setPermissionMode = claude([])
    const session = {
      launchIntent: { permissionMode: 'bypassPermissions' },
      firstRootInit: { permissionMode: 'default' },
      bypassDisabled: false,
      connection: { setPermissionMode }
    }
    expect(await setClaudeAllowedPermissionMode(session, 'bypassPermissions')).toBe('auto')
    expect(setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual(['default', 'auto'])
  })

  it('owes the fallback while Full access is unknown, and when Claude left Approve for me', () => {
    const facts = (
      extra: { firstRootInit?: { permissionMode: string }; bypassDisabled?: boolean },
      build?: string,
      running?: string
    ) => ({
      launchIntent: { permissionMode: 'bypassPermissions' },
      appliedInputOptions: new Map<string, string>(
        build === undefined ? [] : [['buildPermissionMode', build]]
      ),
      reportedOptions: running === undefined ? {} : { reportedPermissionMode: running },
      ...extra
    })
    const refused = { firstRootInit: { permissionMode: 'default' }, bypassDisabled: true }
    expect(claudeOwesFullAccessFallback(facts({}))).toBe(true)
    expect(claudeOwesFullAccessFallback(facts(refused, 'auto', 'auto'))).toBe(false)
    expect(claudeOwesFullAccessFallback(facts(refused, 'auto', 'ask'))).toBe(true)
  })

  it('fails the send when Claude settings turn off the Approve for me the chat chose', async () => {
    for (const autoDisabled of [undefined, true]) {
      const setPermissionMode = claude(['auto'])
      const session = {
        launchIntent: { permissionMode: 'auto' },
        firstRootInit: { permissionMode: 'auto' },
        ...(autoDisabled === undefined ? {} : { autoDisabled }),
        appliedInputOptions: new Map<string, string>(),
        connection: { setPermissionMode }
      }
      await expect(send(session)).rejects.toThrow(AUTO_REFUSAL)
      await expect(send(session)).rejects.toThrow(AUTO_REFUSAL)
      expect(setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual(['auto', 'auto'])
    }
  })

  it('keeps asking for Approve for me when the chat chose it and Claude refused it only for now', async () => {
    const auto = autoForNow()
    const session = {
      launchIntent: { permissionMode: 'auto' },
      firstRootInit: { permissionMode: 'auto' },
      appliedInputOptions: new Map<string, string>(),
      connection: { setPermissionMode: auto.setPermissionMode }
    }
    await expect(send(session)).rejects.toThrow('auto mode is not available for this model')
    auto.available = true
    expect(await send(session)).toBe('auto')
  })
})
