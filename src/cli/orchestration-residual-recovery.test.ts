import { describe, expect, it } from 'vitest'

import { workerStartRecovery } from './orchestration-residual-recovery'

const AGENT_TERMINAL = {
  kind: 'terminal',
  role: 'agent',
  action: 'created',
  id: 'term_agent',
  surface: 'visible'
}

const failedReceipt = (overrides: Record<string, unknown> = {}) => ({
  runId: 'run_1',
  taskId: 'task_1',
  dispatchId: 'ctx_1',
  state: 'failed',
  failedStage: 'dispatch_input',
  effects: [],
  residualResources: [AGENT_TERMINAL],
  ...overrides
})

describe('workerStartRecovery', () => {
  it('routes reclaim of a failed start through its Dispatch, not the terminal handle', () => {
    const recovery = workerStartRecovery(failedReceipt())

    expect(recovery?.commands).toEqual([
      'orca orchestration worker-release --dispatch ctx_1 --json'
    ])
    expect(recovery?.note).toContain('preserves the output')
    expect(JSON.stringify(recovery)).not.toContain('terminal close')
  })

  it('treats the agent terminal of an agent-first worktree as created by this start', () => {
    const recovery = workerStartRecovery(
      failedReceipt({
        residualResources: [
          { kind: 'worktree', action: 'created_child', id: 'repo::child' },
          { ...AGENT_TERMINAL, action: 'reused_agent_terminal' }
        ]
      })
    )

    expect(recovery?.commands).toEqual([
      'orca orchestration worker-release --dispatch ctx_1 --json'
    ])
  })

  it('offers nothing while the start outcome is unknown, because the worker may be live', () => {
    expect(workerStartRecovery(failedReceipt({ state: 'outcome_unknown' }))).toBeUndefined()
  })

  it('offers nothing for a ready worker, whose residual terminal is the live worker', () => {
    expect(workerStartRecovery(failedReceipt({ state: 'ready' }))).toBeUndefined()
  })

  it('offers nothing for setup and configured-tab terminals a new worktree left running', () => {
    expect(
      workerStartRecovery(
        failedReceipt({
          residualResources: [
            { kind: 'terminal', role: 'setup', action: 'created', id: 'term_setup' },
            { kind: 'terminal', role: 'configured_tab', action: 'created', id: 'term_tab' },
            { kind: 'worktree', action: 'created_top_level', id: 'repo::wt' },
            { kind: 'setup', action: 'run', state: 'running', terminalId: 'term_setup' }
          ]
        })
      )
    ).toBeUndefined()
  })

  it('offers nothing for a terminal this start adopted instead of creating', () => {
    expect(
      workerStartRecovery(
        failedReceipt({ residualResources: [{ ...AGENT_TERMINAL, action: 'reused' }] })
      )
    ).toBeUndefined()
  })

  it('keeps a federated residual on its worker server instead of the Run home', () => {
    const recovery = workerStartRecovery(
      failedReceipt({ server: { environmentId: 'env_win', name: 'windows' } })
    )

    expect(recovery?.commands).toEqual(['orca orchestration worker-show --dispatch ctx_1 --json'])
    expect(recovery?.note).toContain('worker server windows')
    expect(JSON.stringify(recovery)).not.toContain('worker-release')
  })

  it('reclaims an SSH-backed worktree through the same Dispatch that owns its host', () => {
    // Why: an SSH worktree has no worker server of its own; this runtime still routes the host.
    const recovery = workerStartRecovery(
      failedReceipt({
        residualResources: [{ ...AGENT_TERMINAL, id: 'term_ssh_agent' }]
      })
    )

    expect(recovery?.commands).toEqual([
      'orca orchestration worker-release --dispatch ctx_1 --json'
    ])
  })

  it('offers no command for a dispatch id outside the shell-neutral class', () => {
    // Why: the id would be pasted into a shell this process cannot identify — PowerShell, a POSIX
    // shell over SSH, WSL — so it is rejected rather than quoted for a guessed shell family.
    const unsafe = [
      'ctx_1; printf INJECTED',
      "ctx_1'; printf INJECTED",
      'ctx_1"; printf INJECTED',
      'ctx_1$(printf INJECTED)',
      'ctx_1`printf INJECTED`',
      'ctx_1 && printf INJECTED',
      'ctx_1|printf',
      'ctx_1%INJECTED%',
      'ctx_1\nprintf INJECTED',
      'ctx_1\r\nprintf INJECTED',
      'ctx_1\u0085printf INJECTED',
      'ctx_1\u009bprintf INJECTED',
      'ctx_1\u2028printf INJECTED',
      'ctx_1\u2029printf INJECTED',
      'ctx_1\u00a0printf INJECTED',
      'ctx_1\u007f',
      'ctx_1\u{1f600}',
      'ctx 1',
      ''
    ]

    for (const dispatchId of unsafe) {
      expect(workerStartRecovery(failedReceipt({ dispatchId }))).toBeUndefined()
      expect(
        workerStartRecovery(failedReceipt({ dispatchId, server: { name: 'windows' } }))
      ).toBeUndefined()
    }
  })

  it('rejects the same ids whatever platform renders the receipt', () => {
    // Why: quoteCliCommandArgument branches on process.platform, which describes the renderer and
    // not the shell that will run the command; this contract must not vary with either.
    const original = process.platform
    try {
      for (const platform of ['win32', 'linux', 'darwin']) {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true })
        expect(
          workerStartRecovery(failedReceipt({ dispatchId: 'ctx_1"; printf INJECTED' }))
        ).toBeUndefined()
        expect(
          workerStartRecovery(failedReceipt({ dispatchId: "ctx_1'; printf INJECTED" }))
        ).toBeUndefined()
        expect(workerStartRecovery(failedReceipt())?.commands).toEqual([
          'orca orchestration worker-release --dispatch ctx_1 --json'
        ])
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('still serves the legacy and remote ids that are shell-neutral', () => {
    for (const dispatchId of ['ctx_1', 'legacy-dispatch.7', 'run:home/ctx_9', 'worker@windows']) {
      expect(workerStartRecovery(failedReceipt({ dispatchId }))?.commands).toEqual([
        `orca orchestration worker-release --dispatch ${dispatchId} --json`
      ])
    }
  })

  it('defers to a host that shipped its own commands', () => {
    expect(
      workerStartRecovery(
        failedReceipt({
          nextCommands: ['orca orchestration worker-abandon --dispatch ctx_1 --json']
        })
      )
    ).toBeUndefined()
    expect(
      workerStartRecovery(failedReceipt({ recoveryCommands: ['orca something --json'] }))
    ).toBeUndefined()
  })

  it('offers nothing when a differently-versioned host shapes the residual another way', () => {
    expect(
      workerStartRecovery(
        failedReceipt({ residualResources: [{ kind: 'terminal', id: 'term_agent' }] })
      )
    ).toBeUndefined()
    expect(
      workerStartRecovery(
        failedReceipt({ residualResources: [{ ...AGENT_TERMINAL, action: 'provisioned' }] })
      )
    ).toBeUndefined()
    expect(
      workerStartRecovery(failedReceipt({ residualResources: [{ ...AGENT_TERMINAL, id: '' }] }))
    ).toBeUndefined()
    expect(workerStartRecovery(failedReceipt({ residualResources: {} }))).toBeUndefined()
    expect(workerStartRecovery(failedReceipt({ dispatchId: '' }))).toBeUndefined()
    expect(workerStartRecovery(undefined)).toBeUndefined()
  })
})
