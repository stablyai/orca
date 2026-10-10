import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslResult, WslSpec } from '../wsl/wsl-runner'
import type {
  createCodexAccountStateDb,
  healPendingCodexAccountThreads
} from './codex-account-session-index-heal'
import type { CodexAppServerInvocation } from './codex-app-server-session'

const { runWslProcessMock, stopping } = vi.hoisted(() => ({
  runWslProcessMock: vi.fn<(spec: WslSpec) => Promise<WslResult>>(),
  stopping: { value: false }
}))

vi.mock('../wsl/wsl-runner', () => ({
  runWslProcess: runWslProcessMock
}))

vi.mock('./codex-account-session-bridge', () => ({
  isCodexAccountSessionBridgeStopping: () => stopping.value
}))

import { _internals, startWslCodexSessionBridgeInBackground } from './wsl-codex-session-bridge'

const MANAGED_HOME =
  '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\codex-accounts\\a1\\home'
const LINUX_HOME = '/home/alice/.local/share/orca/codex-accounts/a1/home'
const TARGET = {
  distro: 'Ubuntu',
  systemCodexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex',
  managedCodexHomePath: MANAGED_HOME
}
const OLDER = 'rollout-2026-09-01T10-00-00-11111111-1111-4111-8111-111111111111.jsonl'
const NEWER = 'rollout-2026-09-02T10-00-00-22222222-2222-4222-8222-222222222222.jsonl'

function bridgeResult(pending: string[], code = 0): WslResult {
  const summary = { scannedFiles: 2, linkedFiles: 2, pendingFiles: pending.length }
  return {
    environmentResolved: true,
    code,
    stdout: `${[...pending, JSON.stringify(summary)].join('\n')}\n`,
    stderr: '',
    timedOut: false
  }
}

const markerClearResult: WslResult = {
  environmentResolved: true,
  code: 0,
  stdout: '',
  stderr: '',
  timedOut: false
}

beforeEach(() => {
  runWslProcessMock.mockReset()
  stopping.value = false
  _internals.reset()
})

describe('startWslCodexSessionBridgeInBackground', () => {
  it('completes the home index inside the distro before linking any history', async () => {
    const order: string[] = []
    const openInvocations: CodexAppServerInvocation[] = []
    const openStateDb = vi.fn<typeof createCodexAccountStateDb>(async (_home, options = {}) => {
      order.push('open')
      const invocation = options.buildInvocation?.(MANAGED_HOME, options.timeoutMs ?? 0)
      if (invocation) {
        openInvocations.push(invocation)
      }
      return true
    })
    runWslProcessMock.mockImplementation(async () => {
      order.push('link')
      return bridgeResult([])
    })

    await startWslCodexSessionBridgeInBackground(TARGET, { openStateDb, healPending: vi.fn() })

    expect(order).toEqual(['open', 'link'])
    expect(openInvocations).toHaveLength(1)
    expect(openInvocations[0]?.cliPath).toBeNull()
    const args = openInvocations[0]?.args ?? []
    expect(args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--exec', 'sh'])
    const guestCommand = args.at(-1) ?? ''
    expect(guestCommand).toContain(`CODEX_HOME=`)
    expect(guestCommand).toContain(LINUX_HOME)
    expect(guestCommand).toContain('features.plugins=false')
    expect(guestCommand).toContain('read-only')
  })

  it('links nothing when Codex cannot bring the home index to complete', async () => {
    const healPending = vi.fn()

    await startWslCodexSessionBridgeInBackground(TARGET, {
      openStateDb: vi.fn(async () => false),
      healPending
    })

    expect(runWslProcessMock).not.toHaveBeenCalled()
    expect(healPending).not.toHaveBeenCalled()
  })

  it('probes a home once per run, since a complete index stays complete', async () => {
    const openStateDb = vi.fn(async () => true)
    runWslProcessMock.mockResolvedValue(bridgeResult([]))

    await startWslCodexSessionBridgeInBackground(TARGET, { openStateDb, healPending: vi.fn() })
    await startWslCodexSessionBridgeInBackground(TARGET, { openStateDb, healPending: vi.fn() })

    expect(openStateDb).toHaveBeenCalledTimes(1)
    expect(runWslProcessMock).toHaveBeenCalledTimes(2)
  })

  it('indexes every pending marker through the guest codex and clears settled markers', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(bridgeResult([NEWER, OLDER]))
      .mockResolvedValue(markerClearResult)
    const healPending = vi.fn<typeof healPendingCodexAccountThreads>(
      async (_home, _pending, options = {}) => {
        await options.afterBatch?.([
          { threadId: '22222222-2222-4222-8222-222222222222', outcome: 'healed' },
          { threadId: '11111111-1111-4111-8111-111111111111', outcome: 'failed' }
        ])
        return {
          outcome: 'completed' as const,
          healedThreads: 1,
          missingThreads: 0,
          failedThreads: 1
        }
      }
    )

    await startWslCodexSessionBridgeInBackground(TARGET, {
      openStateDb: vi.fn(async () => true),
      healPending
    })

    expect(healPending).toHaveBeenCalledTimes(1)
    const [home, pending, options] = healPending.mock.calls[0] ?? []
    expect(home).toBe(MANAGED_HOME)
    expect([...(pending ?? [])]).toEqual([
      ['22222222-2222-4222-8222-222222222222', '2026-09-02T10-00-00'],
      ['11111111-1111-4111-8111-111111111111', '2026-09-01T10-00-00']
    ])
    const heal = options?.buildInvocation?.(MANAGED_HOME, 5_000)
    expect(heal?.args.at(-1)).toContain(LINUX_HOME)
    expect(heal?.timeoutMs).toBe(5_000)
    // A failed read keeps its marker, so it is retried after Orca restarts.
    expect(runWslProcessMock.mock.calls[1]?.[0].args).toEqual([
      `${LINUX_HOME}/.orca-index-pending`,
      NEWER
    ])
  })

  it('still indexes reported markers when one rollout failed to link, then reports the failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runWslProcessMock.mockResolvedValue(bridgeResult([NEWER], 1))
    const healPending = vi.fn(async () => ({
      outcome: 'completed' as const,
      healedThreads: 0,
      missingThreads: 0,
      failedThreads: 0
    }))

    await startWslCodexSessionBridgeInBackground(TARGET, {
      openStateDb: vi.fn(async () => true),
      healPending
    })

    expect(healPending).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[codex-session-bridge] Background WSL session bridge failed:',
      expect.any(Error)
    )
    warn.mockRestore()
  })

  it('skips indexing when the marker list does not match its count', async () => {
    runWslProcessMock.mockResolvedValue({
      ...bridgeResult([NEWER]),
      stdout: `${NEWER}\n${JSON.stringify({ scannedFiles: 2, linkedFiles: 2, pendingFiles: 2 })}\n`
    })
    const healPending = vi.fn()

    await startWslCodexSessionBridgeInBackground(TARGET, {
      openStateDb: vi.fn(async () => true),
      healPending
    })

    expect(healPending).not.toHaveBeenCalled()
  })

  it('indexes the other markers and clears one whose name is not a Codex thread', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(bridgeResult([NEWER, 'rollout-notes.jsonl']))
      .mockResolvedValue(markerClearResult)
    const healPending = vi.fn<typeof healPendingCodexAccountThreads>(async () => ({
      outcome: 'completed' as const,
      healedThreads: 1,
      missingThreads: 0,
      failedThreads: 0
    }))

    await startWslCodexSessionBridgeInBackground(TARGET, {
      openStateDb: vi.fn(async () => true),
      healPending
    })

    expect([...(healPending.mock.calls[0]?.[1] ?? [])]).toEqual([
      ['22222222-2222-4222-8222-222222222222', '2026-09-02T10-00-00']
    ])
    // thread/read can never settle it, so it must not be reported on every launch.
    expect(runWslProcessMock.mock.calls[1]?.[0].args).toEqual([
      `${LINUX_HOME}/.orca-index-pending`,
      'rollout-notes.jsonl'
    ])
  })

  it('does nothing after quit starts', async () => {
    stopping.value = true
    const openStateDb = vi.fn(async () => true)

    await startWslCodexSessionBridgeInBackground(TARGET, { openStateDb, healPending: vi.fn() })

    expect(openStateDb).not.toHaveBeenCalled()
    expect(runWslProcessMock).not.toHaveBeenCalled()
  })
})
