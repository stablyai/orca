import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcSuccess } from '../runtime-client'
import { RuntimeClientError } from '../runtime-client'
import type {
  CreatedRuntimeWorktreeCreateResult,
  RuntimeWorktreeCreateResult
} from '../../shared/runtime-types'
import type { AgentLaunchFailureCode } from '../../shared/agent-launch-contract'
import { AGENT_LAUNCH_IDENTITY_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { buildWorktree } from '../test-fixtures'
import {
  getWorktreeCreateAgentLaunch,
  handleWorktreeCreatePreRejection,
  printWorktreeCreateResult,
  resolveWorktreeCreateLaunchParams,
  type AgentLaunchSource
} from './worktree-create-agent-launch'

type Flags = Map<string, string | boolean>

function flags(entries: Record<string, string | boolean>): Flags {
  return new Map(Object.entries(entries))
}

function envelope(
  result: RuntimeWorktreeCreateResult
): RuntimeRpcSuccess<RuntimeWorktreeCreateResult> {
  return { id: 'req_create', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function createdWorktree(
  agentLaunchResult?: CreatedRuntimeWorktreeCreateResult['agentLaunchResult']
): CreatedRuntimeWorktreeCreateResult {
  return {
    worktree: buildWorktree(
      '/tmp/repo/feature',
      'feature',
      'abc',
      'repo-1'
    ) as unknown as CreatedRuntimeWorktreeCreateResult['worktree'],
    lineage: null,
    warnings: [],
    ...(agentLaunchResult ? { agentLaunchResult } : {})
  }
}

const LAUNCHED = {
  status: 'launched' as const,
  receipt: {
    requestedAgent: 'codex' as const,
    baseAgent: 'codex' as const,
    notices: [],
    launchToken: 'tok-1',
    catalogRevision: 1,
    telemetry: { agentKind: 'codex' as const, usedCustomAgent: false }
  }
}

beforeEach(() => {
  process.exitCode = 0
})

afterEach(() => {
  process.exitCode = 0
  vi.restoreAllMocks()
})

describe('getWorktreeCreateAgentLaunch', () => {
  it('maps --agent <id> to an explicit agent selection carrying the prompt', () => {
    const launch = getWorktreeCreateAgentLaunch(flags({ agent: 'codex', prompt: 'do it' }))
    expect(launch).toEqual({
      request: {
        selection: { kind: 'agent', agent: 'codex' },
        allowEmptyPromptLaunch: true,
        prompt: 'do it'
      },
      source: { via: 'flag', id: 'codex' }
    })
  })

  it('maps a bare --agent to the stored default selection', () => {
    const launch = getWorktreeCreateAgentLaunch(flags({ agent: true }))
    expect(launch).toEqual({
      request: { selection: { kind: 'default' }, allowEmptyPromptLaunch: true },
      source: { via: 'default' }
    })
  })

  it('returns undefined when no agent is requested', () => {
    expect(getWorktreeCreateAgentLaunch(flags({ name: 'feature' }))).toBeUndefined()
  })

  it('rejects --prompt without --agent before any RPC', () => {
    expect(() => getWorktreeCreateAgentLaunch(flags({ prompt: 'hi' }))).toThrow(
      '--prompt requires --agent'
    )
  })

  it('rejects a valueless --prompt', () => {
    expect(() => getWorktreeCreateAgentLaunch(flags({ agent: 'codex', prompt: true }))).toThrow(
      'Missing value for --prompt'
    )
  })

  it('keeps an explicit empty --prompt as an empty draft', () => {
    const launch = getWorktreeCreateAgentLaunch(flags({ agent: 'codex', prompt: '' }))
    expect(launch?.request).toEqual({
      selection: { kind: 'agent', agent: 'codex' },
      allowEmptyPromptLaunch: true,
      prompt: ''
    })
  })

  it('rejects a malformed agent id as invalid_argument', () => {
    try {
      getWorktreeCreateAgentLaunch(flags({ agent: 'not a real agent!!' }))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeClientError)
      expect((error as RuntimeClientError).code).toBe('invalid_argument')
    }
  })
})

const FLAG_SOURCE: AgentLaunchSource = { via: 'flag', id: 'ghost' }
const DEFAULT_SOURCE: AgentLaunchSource = { via: 'default' }

type LaunchClient = Parameters<typeof resolveWorktreeCreateLaunchParams>[0]

function stubClient(options: {
  isRemote: boolean
  capabilities?: string[]
  probeError?: boolean
}): { client: LaunchClient; call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(async () => {
    if (options.probeError) {
      throw new Error('unreachable')
    }
    return {
      id: 'req_status',
      ok: true as const,
      result: { capabilities: options.capabilities },
      _meta: { runtimeId: 'runtime-1' }
    }
  })
  return { client: { isRemote: options.isRemote, call } as unknown as LaunchClient, call }
}

describe('resolveWorktreeCreateLaunchParams', () => {
  const explicitLaunch = getWorktreeCreateAgentLaunch(flags({ agent: 'codex', prompt: 'do it' }))!
  const defaultLaunch = getWorktreeCreateAgentLaunch(flags({ agent: true }))!

  it('sends the host-atomic request without probing a local runtime', async () => {
    const { client, call } = stubClient({ isRemote: false })
    await expect(resolveWorktreeCreateLaunchParams(client, explicitLaunch)).resolves.toEqual({
      agentLaunch: explicitLaunch.request
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('sends the host-atomic request to a remote host advertising the capability', async () => {
    const { client, call } = stubClient({
      isRemote: true,
      capabilities: [AGENT_LAUNCH_IDENTITY_RUNTIME_CAPABILITY]
    })
    await expect(resolveWorktreeCreateLaunchParams(client, explicitLaunch)).resolves.toEqual({
      agentLaunch: explicitLaunch.request
    })
    expect(call).toHaveBeenCalledWith('status.get')
  })

  it('falls back to the legacy host-resolved id fields for a pre-identity remote host', async () => {
    const { client } = stubClient({ isRemote: true, capabilities: [] })
    await expect(resolveWorktreeCreateLaunchParams(client, explicitLaunch)).resolves.toEqual({
      startupAgent: 'codex',
      startupPrompt: 'do it'
    })
  })

  it('reads an unreachable capability probe as a legacy host', async () => {
    const { client } = stubClient({ isRemote: true, probeError: true })
    await expect(resolveWorktreeCreateLaunchParams(client, explicitLaunch)).resolves.toEqual({
      startupAgent: 'codex',
      startupPrompt: 'do it'
    })
  })

  it('fails fast when a pre-identity host is asked for the stored default agent', async () => {
    const { client } = stubClient({ isRemote: true, capabilities: [] })
    await expect(resolveWorktreeCreateLaunchParams(client, defaultLaunch)).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
  })

  it('fails fast when a pre-identity host is asked for a custom agent id', async () => {
    const customLaunch = getWorktreeCreateAgentLaunch(
      flags({ agent: 'custom-agent:codex:01234567-89ab-4cde-8f01-23456789abcd' })
    )!
    const { client } = stubClient({ isRemote: true, capabilities: [] })
    await expect(resolveWorktreeCreateLaunchParams(client, customLaunch)).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
  })
})

describe('handleWorktreeCreatePreRejection', () => {
  it('returns the created arm unchanged when the worktree was created', () => {
    const created = createdWorktree(LAUNCHED)
    const result = handleWorktreeCreatePreRejection(envelope(created), FLAG_SOURCE, false)
    expect(result).toBe(created)
    expect(process.exitCode).toBe(0)
  })

  it('prints the stable code and human line to stderr and exits non-zero on a failed rejection', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = envelope({
      created: false,
      agentLaunchResult: { status: 'failed', failure: { code: 'unknown_agent' } }
    })

    const result = handleWorktreeCreatePreRejection(response, FLAG_SOURCE, false)

    expect(result).toBeNull()
    expect(errSpy.mock.calls[0][0]).toBe('unknown_agent')
    expect(errSpy.mock.calls[1][0]).toContain('ghost')
    expect(errSpy.mock.calls[1][0]).toContain('--agent')
    expect(process.exitCode).toBe(1)
  })

  it('names the stored default agent for a default-sourced rejection', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = envelope({
      created: false,
      agentLaunchResult: {
        status: 'failed',
        failure: { code: 'base_agent_disabled', baseAgent: 'codex' }
      }
    })

    handleWorktreeCreatePreRejection(response, DEFAULT_SOURCE, false)

    expect(errSpy.mock.calls[0][0]).toBe('base_agent_disabled')
    expect(errSpy.mock.calls[1][0]).toContain('stored default')
    expect(process.exitCode).toBe(1)
  })

  it('keeps the human line generic for a failure code from a newer host', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = envelope({
      created: false,
      agentLaunchResult: {
        status: 'failed',
        failure: { code: 'launch_reason_from_the_future' as AgentLaunchFailureCode }
      }
    })

    handleWorktreeCreatePreRejection(response, FLAG_SOURCE, false)

    expect(errSpy.mock.calls[0][0]).toBe('launch_reason_from_the_future')
    expect(errSpy.mock.calls[1][0]).not.toContain('undefined')
    expect(errSpy.mock.calls[1][0]).toContain('does not recognize')
    expect(process.exitCode).toBe(1)
  })

  it('surfaces a request-error rejection code and exits non-zero', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = envelope({
      created: false,
      agentLaunchResult: { status: 'rejected', requestError: { code: 'idempotency_conflict' } }
    })

    handleWorktreeCreatePreRejection(response, FLAG_SOURCE, false)

    expect(errSpy.mock.calls[0][0]).toBe('idempotency_conflict')
    expect(process.exitCode).toBe(1)
  })

  it('prints the typed rejection envelope in JSON mode without a stderr line', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = envelope({
      created: false,
      agentLaunchResult: { status: 'failed', failure: { code: 'unknown_agent' } }
    })

    handleWorktreeCreatePreRejection(response, FLAG_SOURCE, true)

    expect(logSpy.mock.calls.flat().join('\n')).toContain('unknown_agent')
    expect(errSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})

describe('printWorktreeCreateResult', () => {
  it('prints the created worktree and leaves the exit code clean on a launched result', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const created = createdWorktree(LAUNCHED)

    printWorktreeCreateResult(envelope(created), created, FLAG_SOURCE, false)

    expect(logSpy).toHaveBeenCalled()
    expect(process.exitCode).toBe(0)
  })

  it('prints the retained worktree then the stderr contract and exits non-zero on a post-create failure', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const created = createdWorktree({
      status: 'failed',
      failure: {
        code: 'missing_variable',
        version: 1,
        failureId: 'f1',
        intent: 'cli',
        occurredAt: 0,
        variable: 'worktreePath'
      }
    })

    printWorktreeCreateResult(envelope(created), created, FLAG_SOURCE, false)

    // Stable post-create output: the retained worktree prints on stdout first.
    expect(logSpy.mock.calls.flat().join('\n')).toContain('/tmp/repo/feature')
    expect(errSpy.mock.calls[0][0]).toBe('missing_variable')
    expect(process.exitCode).toBe(1)
  })

  it('keeps the failure inside the JSON envelope without a stderr line', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const created = createdWorktree({
      status: 'failed',
      failure: {
        code: 'spawn_failed',
        version: 1,
        failureId: 'f2',
        intent: 'cli',
        occurredAt: 0
      }
    })

    printWorktreeCreateResult(envelope(created), created, FLAG_SOURCE, true)

    expect(logSpy.mock.calls.flat().join('\n')).toContain('spawn_failed')
    expect(errSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})
