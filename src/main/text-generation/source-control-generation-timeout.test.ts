import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_NAME_GENERATION_TIMEOUT_MS,
  SOURCE_CONTROL_GENERATION_TIMEOUT_MS
} from './source-control-generation-limits'
import {
  generateBranchName,
  generateCommitMessage
} from './source-control-text-generation-requests'
import type {
  RemoteCommitMessageExecResult,
  SpawnedSourceControlAgentProcess
} from './source-control-text-generation-types'

// An agent that never answers, as Cursor does while it waits on unreachable MCP servers.
function silentAgent(): SpawnedSourceControlAgentProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: 4343,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { on: vi.fn(), end: vi.fn() },
    kill: vi.fn(() => {
      setTimeout(() => child.emit('close', null, 'SIGKILL'), 0)
      return true
    })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: generation reads only pid, kill, the stdio streams and child events, which the fake implements.
  return child as unknown as SpawnedSourceControlAgentProcess
}

const cursorParams = { agentId: 'cursor' as const, model: 'auto' }

afterEach(() => {
  vi.useRealTimers()
})

describe('source control generation timeouts', () => {
  it('gives a background branch name longer than an interactive request before giving up', async () => {
    vi.useFakeTimers()
    let settled = false
    const result = generateBranchName({
      context: { firstPrompt: 'fix the branch auto-name timeout' },
      params: cursorParams,
      target: { kind: 'local', cwd: '/repo/branch-name-timeout' },
      spawnAgent: vi.fn(silentAgent)
    }).finally(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(SOURCE_CONTROL_GENERATION_TIMEOUT_MS + 10_000)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(
      BACKGROUND_NAME_GENERATION_TIMEOUT_MS - SOURCE_CONTROL_GENERATION_TIMEOUT_MS - 10_000
    )
    await expect(result).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/^Cursor did not finish within 180s\. .*MCP servers/)
    })
  })

  it('keeps the interactive budget for a commit message and names the agent', async () => {
    vi.useFakeTimers()
    const result = generateCommitMessage({
      context: {
        branch: 'main',
        stagedSummary: 'M README.md',
        stagedPatch: '+test'
      },
      params: cursorParams,
      target: { kind: 'local', cwd: '/repo/commit-timeout' },
      spawnAgent: vi.fn(silentAgent)
    })

    await vi.advanceTimersByTimeAsync(SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
    await expect(result).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/^Cursor did not finish within 60s\./)
    })
  })

  it('asks a remote host for the background budget and reports its timeout the same way', async () => {
    const execute = vi.fn(async (): Promise<RemoteCommitMessageExecResult> => ({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: true
    }))

    const result = await generateBranchName({
      context: { firstPrompt: 'fix the branch auto-name timeout' },
      params: cursorParams,
      target: {
        kind: 'remote',
        cwd: '/remote/repo',
        execute,
        missingBinaryLocation: 'SSH host'
      },
      spawnAgent: vi.fn(silentAgent)
    })

    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      '/remote/repo',
      BACKGROUND_NAME_GENERATION_TIMEOUT_MS,
      'branch-name'
    )
    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/^Cursor did not finish within 180s\./)
    })
  })
})
