import { terminalStartError } from '../../../shared/terminal-start-failure'
import { describe, expect, it } from 'vitest'
import { mapRuntimeError } from './errors'
import {
  ARTIFACT_SHARING_DISABLED_CODE,
  ARTIFACT_SHARING_DISABLED_MESSAGE,
  ArtifactSharingDisabledError
} from '../../../shared/artifact-sharing-gate'
import {
  AUTOMATION_OWNER_CONFLICT_CODES,
  AutomationOwnerConflictError
} from '../../../shared/automation-owner-conflict'
import {
  NESTED_WORKER_DEPTH_EXCEEDED_CODE,
  NESTED_WORKER_DEPTH_EXCEEDED_NEXT_STEPS,
  nestedWorkerDepthExceededMessage
} from '../../../shared/nested-worker-depth'
import { OrchestrationError } from '../orchestration/orchestration-error'
import {
  AgentSessionRefusalError,
  agentSessionRefusalError,
  refuseUnclassified
} from '../../../shared/agent-session-wire-refusals'
import { readAgentSessionErrorRefusal } from '../../../shared/agent-session-write-failure'
import { WslHostWindowsDriveRefusalError } from '../../../shared/wsl-host-windows-drive-refusal'

class LineageError extends Error {
  code = 'LINEAGE_PARENT_NOT_FOUND'
  data = {
    nextSteps: ['Run `orca worktree list`.', 'Retry with --no-parent.']
  }
}

describe('mapRuntimeError', () => {
  it.each(['agent_session_exited_during_start', 'agent_session_operation_unknown'] as const)(
    'preserves %s while explaining the failed start',
    (code) => {
      const startError = terminalStartError('agent_session_exited_during_start', {
        kind: 'exited',
        exitCode: 256,
        initialOutputDiagnostic: 'git-bash-console-capacity'
      })
      const error =
        code === 'agent_session_operation_unknown'
          ? new Error(code, { cause: startError })
          : startError
      const response = mapRuntimeError('start', { runtimeId: 'host' }, error)
      expect(response).toMatchObject({
        id: 'start',
        ok: false,
        _meta: { runtimeId: 'host' },
        error: {
          code,
          message: expect.stringContaining('Git Bash reported its limit of 128 open terminals')
        }
      })
      expect(response.error.message).toContain('Close some Git Bash terminals and try again.')
      expect(response.error.message.includes("Couldn't confirm the terminal started.")).toBe(
        code === 'agent_session_operation_unknown'
      )
    }
  )

  it('keeps runtime_error and a readable message for a WSL host Windows drive refusal', () => {
    const error = new WslHostWindowsDriveRefusalError('C:\\src\\app')
    expect(mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, error)).toMatchObject({
      ok: false,
      error: {
        code: 'runtime_error',
        message: expect.stringContaining('This folder is on a Windows drive (C:\\src\\app).'),
        data: { kind: 'wsl_host_windows_drive_path', windowsPath: 'C:\\src\\app' }
      }
    })
  })

  it.each([
    [
      'terminal_held_wsl_distro_stopped:Ubuntu',
      'stopped',
      "The WSL distro Ubuntu is stopped, so Orca didn't start this terminal. Start the distro, then try again."
    ],
    [
      'terminal_held_wsl_distro_unverifiable:Ubuntu',
      'unverifiable',
      "Orca couldn't check whether the WSL distro Ubuntu is running, so it didn't start this terminal. Start the distro, then try again."
    ]
  ])(
    'keeps runtime_error for a held terminal (%s) with a readable message',
    (raw, state, message) => {
      expect(mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, new Error(raw))).toMatchObject({
        ok: false,
        error: {
          code: 'runtime_error',
          message,
          data: { wslDistroHold: { distro: 'Ubuntu', state } }
        }
      })
    }
  )

  it('maps SSH and other errors exactly as before', () => {
    for (const raw of ['ssh_connection_lost', 'Terminal not found', 'spawn exploded']) {
      const mapped = mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, new Error(raw))
      expect(mapped).toMatchObject({ ok: false, error: { code: 'runtime_error', message: raw } })
      expect(mapped.ok === false ? mapped.error.data : undefined).toBeUndefined()
    }
  })

  it('names a deferred fork with its own code and reason', () => {
    expect(
      mapRuntimeError(
        'req_1',
        { runtimeId: 'runtime-1' },
        new Error('terminal_spawn_deferred:paused')
      )
    ).toMatchObject({
      ok: false,
      error: {
        code: 'terminal_spawn_deferred',
        message: 'terminal_spawn_deferred:paused',
        data: { reason: 'paused' }
      }
    })
    expect(
      mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, new Error('terminal_spawn_deferred:x'))
    ).toMatchObject({ error: { code: 'runtime_error' } })
  })

  it('preserves the stable skill failure category and retryability across RPC', () => {
    expect(
      mapRuntimeError(
        'req_1',
        { runtimeId: 'runtime-1' },
        new Error('skill-download-transport-failed')
      )
    ).toMatchObject({
      ok: false,
      error: {
        code: 'skill_install_failure',
        message: 'skill-download-transport-failed',
        data: {
          category: 'transport',
          code: 'skill-download-transport-failed',
          retryable: true
        }
      }
    })
  })

  it.each(['terminal_tab_close_timeout', 'terminal_tab_not_found', 'terminal_tab_pinned'])(
    'preserves the durable terminal tab close failure %s',
    (code) => {
      expect(mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, new Error(code))).toMatchObject({
        ok: false,
        error: { code, message: code }
      })
    }
  )

  it.each(['agent_prompt_blocked', 'agent_prompt_stalled', 'request_aborted'])(
    'preserves the agent prompt failure %s',
    (code) => {
      expect(mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, new Error(code))).toMatchObject({
        ok: false,
        error: { code, message: code }
      })
    }
  )

  it.each([
    'remote_update_manual_required',
    'remote_update_not_available',
    'remote_update_not_downloaded'
  ])('preserves remote updater failure %s', (code) => {
    expect(mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, new Error(code))).toMatchObject({
      ok: false,
      error: { code, message: code }
    })
  })

  it.each(['remote_runtime_unavailable', 'runtime_timeout', 'invalid_runtime_response'])(
    'preserves structured remote transport failure %s',
    (code) => {
      const error = Object.assign(new Error(`Remote transport failed: ${code}`), { code })

      expect(mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, error)).toMatchObject({
        ok: false,
        error: { code, message: `Remote transport failed: ${code}` }
      })
    }
  )

  it.each([
    ['window_not_focused', 'keyboard input requires focus', 'restore-window'],
    ['permission_denied', 'missing DBUS_SESSION_BUS_ADDRESS', 'permissions'],
    ['element_not_found', 'fresh element index required', 'get-app-state'],
    ['unsupported_capability', 'hotkey combinations require xdotool', 'capabilities'],
    [
      'action_not_supported',
      'Raise is not a valid secondary action',
      'advertised secondary actions'
    ],
    ['value_not_settable', 'element value is not settable', 'settable text element'],
    ['element_not_clickable', 'element has no actionable frame', 'actionable frame'],
    ['invalid_argument', 'click_count must be a positive integer', 'Do not retry'],
    ['action_timeout', 'computer sidecar click timed out', 'do not repeat'],
    ['screenshot_failed', 'screenshot capture returned no image', '--no-screenshot'],
    ['accessibility_error', 'desktop script provider is not available', 'capabilities']
  ])('adds recovery steps for computer-use %s errors', (code, message, recoveryFragment) => {
    const error = new Error(message)
    Object.assign(error, { code })

    const response = mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, error)

    expect(response.error).toMatchObject({
      code,
      message,
      data: {
        nextSteps: expect.arrayContaining([expect.stringContaining(recoveryFragment)])
      }
    })
  })

  it('adds computer-use startup recovery steps for missing desktop apps', () => {
    const error = new Error('app not found: Gmail')
    Object.assign(error, { code: 'app_not_found' })

    const response = mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, error)

    expect(response.error).toMatchObject({
      code: 'app_not_found',
      message: 'app not found: Gmail',
      data: {
        nextSteps: [
          expect.stringContaining('list-apps'),
          expect.stringContaining('desktop browser app/window'),
          expect.stringContaining('--app <web app>'),
          expect.stringContaining('list-windows --app <browser>')
        ]
      }
    })
  })

  it('adds computer-use recovery steps for missing desktop windows', () => {
    const error = new Error('No top-level window found')
    Object.assign(error, { code: 'window_not_found' })

    const response = mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, error)

    expect(response.error).toMatchObject({
      code: 'window_not_found',
      data: {
        nextSteps: [
          expect.stringContaining('list-windows'),
          expect.stringContaining('--restore-window'),
          expect.stringContaining('does not launch closed desktop apps')
        ]
      }
    })
  })

  it('preserves structured computer-use focus error codes for CLI recovery hints', () => {
    const error = new Error(
      'keyboard input requires the target window to be focused; retry with --restore-window'
    )
    Object.assign(error, { code: 'window_not_focused' })

    const response = mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, error)

    expect(response).toEqual({
      id: 'req_1',
      ok: false,
      error: {
        code: 'window_not_focused',
        message:
          'keyboard input requires the target window to be focused; retry with --restore-window',
        data: {
          nextSteps: [
            'Retry once with `--restore-window`.',
            'If `--restore-window` was already used, stop retrying restore; bring the app forward manually, check permissions, or prefer `set-value` for editable fields.'
          ]
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
  })

  it('does not recommend a blind retry after a coordinate press may have landed', () => {
    const message =
      'coordinate click aborted because the recipient changed; 1 press(es) may already have been delivered'
    const error = Object.assign(new Error(message), { code: 'window_not_focused' })

    const response = mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, error)

    expect(response.error).toMatchObject({
      code: 'window_not_focused',
      message,
      data: {
        nextSteps: [
          expect.stringContaining('verify whether the intended action already occurred'),
          expect.stringContaining('Do not retry the click if it already took effect')
        ]
      }
    })
  })

  it('preserves structured lineage error codes and data for CLI recovery hints', () => {
    const response = mapRuntimeError(
      'req_1',
      { runtimeId: 'runtime-1' },
      new LineageError('Parent selector was not found.')
    )

    expect(response).toEqual({
      id: 'req_1',
      ok: false,
      error: {
        code: 'LINEAGE_PARENT_NOT_FOUND',
        message: 'Parent selector was not found.',
        data: {
          nextSteps: ['Run `orca worktree list`.', 'Retry with --no-parent.']
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
  })
})

describe('artifact sharing denial', () => {
  it('reaches the CLI with its code, message, and next steps intact', () => {
    expect(
      mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, new ArtifactSharingDisabledError())
    ).toMatchObject({
      ok: false,
      error: {
        code: ARTIFACT_SHARING_DISABLED_CODE,
        message: ARTIFACT_SHARING_DISABLED_MESSAGE,
        data: { nextSteps: expect.arrayContaining([expect.stringContaining('Settings')]) }
      }
    })
  })
})

// Clients need distinct owner-conflict codes to choose reload, re-adopt or stop offering the action.
describe('automation owner conflicts', () => {
  it.each(Object.values(AUTOMATION_OWNER_CONFLICT_CODES))(
    'passes %s through structured',
    (code) => {
      expect(
        mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, new AutomationOwnerConflictError(code))
      ).toMatchObject({ ok: false, error: { code } })
    }
  )

  it('still lets an old runtime be classified from the message tail', () => {
    const error = new AutomationOwnerConflictError(AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged)
    expect(error.message.endsWith(`: ${AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged}`)).toBe(true)
  })
})

describe('nested worker depth cap', () => {
  it('keeps its code and next steps instead of collapsing to runtime_error', () => {
    const failure = mapRuntimeError(
      'rpc_depth',
      { runtimeId: 'runtime-1' },
      new OrchestrationError(
        NESTED_WORKER_DEPTH_EXCEEDED_CODE,
        nestedWorkerDepthExceededMessage(2, 1),
        { effectsApplied: false, nextSteps: [...NESTED_WORKER_DEPTH_EXCEEDED_NEXT_STEPS] }
      )
    )

    expect(failure.error.code).toBe(NESTED_WORKER_DEPTH_EXCEEDED_CODE)
    expect(failure.error.data).toMatchObject({
      effectsApplied: false,
      nextSteps: [...NESTED_WORKER_DEPTH_EXCEEDED_NEXT_STEPS]
    })
  })
})

describe('structured worker dispatch preamble errors', () => {
  it('preserves the undelivered verdict across runtime RPC', () => {
    const failure = mapRuntimeError(
      'rpc_dispatch_preamble',
      { runtimeId: 'runtime-1' },
      new OrchestrationError(
        'dispatch_preamble_undelivered',
        'The dispatch preamble was not delivered: provider_write_failed: broken pipe.'
      )
    )

    expect(failure).toMatchObject({
      ok: false,
      error: {
        code: 'dispatch_preamble_undelivered',
        message: 'The dispatch preamble was not delivered: provider_write_failed: broken pipe.'
      }
    })
  })
})

describe('thrown agent-session refusals', () => {
  const meta = { runtimeId: 'runtime-1' }

  // Released clients match both wire code and message; preserve the prior bare Error(code) contract.
  it.each([
    [
      'agent_session_ownership_unknown',
      'agent_session_ownership_unknown',
      agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'noLiveOwner' })
    ],
    [
      'structured_agent_session_unsupported',
      'runtime_error',
      agentSessionRefusalError('structured_agent_session_unsupported', { reason: 'hostDisabled' })
    ],
    [
      'agent_session_checkpoint_stale',
      'agent_session_checkpoint_stale',
      agentSessionRefusalError('agent_session_checkpoint_stale', {
        reason: 'fenceStale',
        currentFence: 4
      })
    ]
  ] as const)(
    'keeps %s on the wire as it was, and adds its details in data',
    (code, wire, error) => {
      const before = mapRuntimeError('req_1', meta, new Error(code))
      const after = mapRuntimeError('req_1', meta, error)
      expect(after.error.code).toBe(before.error.code)
      expect(after.error.code).toBe(wire)
      expect(after.error.message).toBe(before.error.message)
      expect(after.error.message).toBe(code)
      expect(after.error.data).toEqual({ refusal: { code, details: error.refusal.details } })
      expect(error.refusal.details?.reason).toBeDefined()
    }
  )

  it('carries no details in data when the refusal named none', () => {
    const response = mapRuntimeError(
      'req_1',
      meta,
      new AgentSessionRefusalError(
        refuseUnclassified('agent_session_conflict', 'Another process claims this session.')
      )
    )
    expect(response.error).toEqual({
      code: 'agent_session_conflict',
      message: 'agent_session_conflict',
      data: { refusal: { code: 'agent_session_conflict' } }
    })
  })

  it("sends a journal refusal's reason where a client reads it", () => {
    const response = mapRuntimeError(
      'req_1',
      meta,
      agentSessionRefusalError(
        'agent_session_journal_unreadable',
        { reason: 'journalCorrupt' },
        'Unable to load this chat.'
      )
    )
    const wire = JSON.parse(JSON.stringify(response.error))
    expect(wire).toEqual({
      code: 'runtime_error',
      message: 'agent_session_journal_unreadable',
      data: {
        refusal: {
          code: 'agent_session_journal_unreadable',
          details: { reason: 'journalCorrupt' }
        }
      }
    })
    expect(readAgentSessionErrorRefusal(wire)).toEqual({
      code: 'agent_session_journal_unreadable',
      details: { reason: 'journalCorrupt' }
    })
  })

  it('exposes no code property another passthrough could claim', () => {
    expect(
      'code' in agentSessionRefusalError('agent_session_conflict', { reason: 'claimConflicted' })
    ).toBe(false)
  })
})
