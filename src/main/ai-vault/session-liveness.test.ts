import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { PtyProcessInfo } from '../providers/pty-process-info'
import {
  readAiVaultSessionIdentity,
  resolveAiVaultSessionLiveness,
  type AiVaultSessionLivenessDependencies
} from './session-liveness'

function processInfo(id: string, terminalHandle = `term_${id}`): PtyProcessInfo {
  return { id, terminalHandle, cwd: '/workspace', title: 'terminal' }
}

function status(args: {
  sessionId: string
  ptyId: string
  connectionId?: string | null
}): AgentStatusIpcPayload {
  return {
    paneKey: `tab:${args.ptyId}`,
    terminalHandle: `term_${args.ptyId}`,
    connectionId: args.connectionId ?? null,
    receivedAt: 1,
    stateStartedAt: 1,
    state: 'working',
    prompt: 'test',
    agentType: 'gemini',
    providerSession: { key: 'session_id', id: args.sessionId }
  }
}

function dependencies(
  overrides: Partial<AiVaultSessionLivenessDependencies> = {}
): AiVaultSessionLivenessDependencies {
  return {
    listProcesses: async () => [],
    getStatusSnapshot: () => [],
    inspectForegroundProcess: async () => ({ available: true, process: 'zsh' }),
    getStatusPtyId: (row) => row.terminalHandle?.slice('term_'.length) ?? null,
    getAgentHint: () => null,
    ...overrides
  }
}

describe('resolveAiVaultSessionLiveness', () => {
  it('binds renderer identity to the session parsed from the validated transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-delete-identity-'))
    const filePath = join(root, 'session.json')
    await writeFile(
      filePath,
      JSON.stringify({
        sessionId: 'authoritative-session',
        startTime: '2026-08-07T00:00:00.000Z',
        lastUpdated: '2026-08-07T00:01:00.000Z',
        messages: [{ type: 'user', content: 'test' }]
      })
    )
    try {
      await expect(
        readAiVaultSessionIdentity({
          agent: 'gemini',
          sessionId: 'spoofed-session',
          filePath
        })
      ).resolves.toEqual({ outcome: 'unknown' })
      await expect(
        readAiVaultSessionIdentity({
          agent: 'gemini',
          sessionId: 'authoritative-session',
          filePath
        })
      ).resolves.toEqual({ outcome: 'found', sessionId: 'authoritative-session' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finds a paired-owned live session without consulting a renderer pane snapshot', async () => {
    const deps = dependencies({
      listProcesses: async () => [processInfo('paired-pty')],
      getStatusSnapshot: () => [status({ sessionId: 'session-live', ptyId: 'paired-pty' })],
      inspectForegroundProcess: async () => ({ available: true, process: 'gemini' })
    })

    await expect(
      resolveAiVaultSessionLiveness({ agent: 'gemini', sessionId: 'session-live' }, deps)
    ).resolves.toBe('live')
  })

  it('reads hook identity after a controlled process-inventory barrier', async () => {
    let releaseInventory: (processes: PtyProcessInfo[]) => void = () => {}
    const inventory = new Promise<PtyProcessInfo[]>((resolve) => {
      releaseInventory = resolve
    })
    let statuses = [status({ sessionId: 'session-other', ptyId: 'paired-pty' })]
    const deps = dependencies({
      listProcesses: () => inventory,
      getStatusSnapshot: () => statuses,
      inspectForegroundProcess: async () => ({ available: true, process: 'gemini' })
    })

    const liveness = resolveAiVaultSessionLiveness(
      { agent: 'gemini', sessionId: 'session-live' },
      deps
    )
    statuses = [status({ sessionId: 'session-live', ptyId: 'paired-pty' })]
    releaseInventory([processInfo('paired-pty')])

    await expect(liveness).resolves.toBe('live')
  })

  it('reads hook identity after a controlled foreground-inspection barrier', async () => {
    let markInspectionStarted: () => void = () => {}
    const inspectionStarted = new Promise<void>((resolve) => {
      markInspectionStarted = resolve
    })
    let releaseInspection: (inspection: {
      available: boolean
      process: string | null
    }) => void = () => {}
    const inspection = new Promise<{ available: boolean; process: string | null }>((resolve) => {
      releaseInspection = resolve
    })
    let statuses = [status({ sessionId: 'session-other', ptyId: 'managed-pty' })]
    const deps = dependencies({
      listProcesses: async () => [processInfo('managed-pty')],
      getStatusSnapshot: () => statuses,
      inspectForegroundProcess: () => {
        markInspectionStarted()
        return inspection
      }
    })

    const liveness = resolveAiVaultSessionLiveness(
      { agent: 'gemini', sessionId: 'session-live' },
      deps
    )
    await inspectionStarted
    statuses = [status({ sessionId: 'session-live', ptyId: 'managed-pty' })]
    releaseInspection({ available: true, process: 'gemini' })

    await expect(liveness).resolves.toBe('live')
  })

  it('treats WSL hook ownership as local authority', async () => {
    const deps = dependencies({
      listProcesses: async () => [processInfo('wsl-pty')],
      getStatusSnapshot: () => [
        status({ sessionId: 'session-live', ptyId: 'wsl-pty', connectionId: 'wsl:Ubuntu' })
      ],
      inspectForegroundProcess: async () => ({ available: true, process: 'gemini' })
    })

    await expect(
      resolveAiVaultSessionLiveness({ agent: 'gemini', sessionId: 'session-live' }, deps)
    ).resolves.toBe('live')
  })

  it('does not use SSH identity as local liveness evidence', async () => {
    const deps = dependencies({
      listProcesses: async () => [processInfo('local-pty')],
      getStatusSnapshot: () => [
        status({ sessionId: 'session-live', ptyId: 'local-pty', connectionId: 'ssh:dev-box' })
      ],
      inspectForegroundProcess: async () => ({ available: true, process: 'gemini' })
    })

    await expect(
      resolveAiVaultSessionLiveness({ agent: 'gemini', sessionId: 'session-live' }, deps)
    ).resolves.toBe('unknown')
  })

  it('returns not-live when every local Gemini process owns another known session', async () => {
    const deps = dependencies({
      listProcesses: async () => [processInfo('other-pty')],
      getStatusSnapshot: () => [status({ sessionId: 'session-other', ptyId: 'other-pty' })],
      inspectForegroundProcess: async () => ({ available: true, process: 'gemini' })
    })

    await expect(
      resolveAiVaultSessionLiveness({ agent: 'gemini', sessionId: 'session-target' }, deps)
    ).resolves.toBe('not-live')
  })

  it.each([
    ['missing session identity', dependencies(), undefined],
    [
      'unavailable process inventory',
      dependencies({
        listProcesses: async () => {
          throw new Error('daemon offline')
        }
      }),
      'session-live'
    ],
    [
      'unattributed live agent process',
      dependencies({
        listProcesses: async () => [processInfo('unknown-pty')],
        inspectForegroundProcess: async () => ({ available: true, process: 'gemini' })
      }),
      'session-live'
    ]
  ])('preserves unknown for %s', async (_name, deps, sessionId) => {
    await expect(resolveAiVaultSessionLiveness({ agent: 'gemini', sessionId }, deps)).resolves.toBe(
      'unknown'
    )
  })

  it('bounds foreground inspection concurrency', async () => {
    let active = 0
    let maxActive = 0
    const inspectForegroundProcess = vi.fn(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => queueMicrotask(resolve))
      active -= 1
      return { available: true, process: 'zsh' }
    })
    const deps = dependencies({
      listProcesses: async () =>
        Array.from({ length: 20 }, (_, index) => processInfo(`shell-${index}`)),
      inspectForegroundProcess
    })

    await expect(
      resolveAiVaultSessionLiveness({ agent: 'gemini', sessionId: 'session-target' }, deps)
    ).resolves.toBe('not-live')
    expect(inspectForegroundProcess).toHaveBeenCalledTimes(20)
    expect(maxActive).toBeLessThanOrEqual(8)
  })

  it('fails closed before inspecting an oversized inventory', async () => {
    const inspectForegroundProcess = vi.fn()
    const deps = dependencies({
      listProcesses: async () =>
        Array.from({ length: 513 }, (_, index) => processInfo(`shell-${index}`)),
      inspectForegroundProcess
    })

    await expect(
      resolveAiVaultSessionLiveness({ agent: 'gemini', sessionId: 'session-target' }, deps)
    ).resolves.toBe('unknown')
    expect(inspectForegroundProcess).not.toHaveBeenCalled()
  })

  it('does not start foreground inspections after the shared deadline', async () => {
    const inspectForegroundProcess = vi.fn()
    const deps = dependencies({
      deadlineMs: 0,
      listProcesses: async () => [processInfo('late-pty')],
      inspectForegroundProcess
    })

    await expect(
      resolveAiVaultSessionLiveness({ agent: 'gemini', sessionId: 'session-target' }, deps)
    ).resolves.toBe('unknown')
    expect(inspectForegroundProcess).not.toHaveBeenCalled()
  })
})
