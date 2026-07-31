import { describe, expect, it, vi } from 'vitest'
import {
  DAEMON_GONE_PROOFS,
  probeDaemonProcessIdentity,
  WINDOWS_CREATION_TIME_TOLERANCE_MS,
  type DaemonProcessProbeDependencies,
  type ExactDaemonIncarnation
} from './daemon-incarnation-evidence'
import {
  classifyDaemonAuditFailure,
  recordAuthenticatedInventory,
  type DaemonAuditClassifierDependencies,
  type DaemonAuditContext
} from './daemon-audit-classifier'

const endpoint = { socketPath: '/runtime/daemon.sock', tokenPath: '/runtime/daemon.token' }
const exactIncarnation: ExactDaemonIncarnation = {
  identity: { pid: 42, startedAtMs: 1_700_000_000_000, launchNonce: 'launch-a' },
  linuxStartTicks: '4242',
  bootId: 'boot-a'
}
const auditClassifierDependencies = {
  probeProcessIdentity: async () => ({
    state: 'unknown',
    reason: 'inspection_failed',
    evidenceSources: ['process_signal']
  }),
  inspectEndpointState: async (context) =>
    context.endpointKind === 'windows-named-pipe' ? 'named-pipe' : 'missing'
} satisfies DaemonAuditClassifierDependencies

function linuxStat(state: string, startTicks: string): string {
  return `42 (orca daemon with spaces) ${[state, ...Array(18).fill('0'), startTicks].join(' ')}`
}

function linuxDependencies(
  overrides: DaemonProcessProbeDependencies = {}
): DaemonProcessProbeDependencies {
  return {
    platform: 'linux',
    signalProcess: () => 'occupied',
    readLinuxStat: async () => ({ status: 'present', value: linuxStat('S', '4242') }),
    readBootIdentity: async () => 'boot-a',
    readCommandLine: async () =>
      `node daemon-entry --socket ${endpoint.socketPath} --token ${endpoint.tokenPath}`,
    ...overrides
  }
}

describe('daemon process identity evidence', () => {
  it('pins the dated conclusive-gone oracle contract', () => {
    expect(DAEMON_GONE_PROOFS).toEqual({
      linux: ['pid_missing', 'linux_boot_changed', 'linux_start_ticks_mismatch', 'linux_zombie'],
      darwin: ['pid_missing'],
      win32: [
        'windows_process_missing',
        'windows_creation_time_mismatch',
        'windows_named_pipe_missing'
      ]
    })
  })

  it('proves Linux pid reuse from native start ticks without derived milliseconds', async () => {
    const readProcessStartedAtMs = vi.fn(async () => exactIncarnation.identity.startedAtMs)

    await expect(
      probeDaemonProcessIdentity(
        exactIncarnation,
        endpoint,
        linuxDependencies({
          readLinuxStat: async () => ({ status: 'present', value: linuxStat('S', '4243') }),
          readProcessStartedAtMs
        })
      )
    ).resolves.toMatchObject({
      state: 'gone',
      reason: 'linux_start_ticks_mismatch'
    })
    expect(readProcessStartedAtMs).not.toHaveBeenCalled()
  })

  it('proves Linux reboot invalidated the recorded incarnation', async () => {
    await expect(
      probeDaemonProcessIdentity(
        exactIncarnation,
        endpoint,
        linuxDependencies({ readBootIdentity: async () => 'boot-b' })
      )
    ).resolves.toMatchObject({ state: 'gone', reason: 'linux_boot_changed' })
  })

  it('treats a matching unreaped Linux zombie as gone', async () => {
    await expect(
      probeDaemonProcessIdentity(
        exactIncarnation,
        endpoint,
        linuxDependencies({
          readLinuxStat: async () => ({ status: 'present', value: linuxStat('Z', '4242') })
        })
      )
    ).resolves.toMatchObject({ state: 'gone', reason: 'linux_zombie' })
  })

  it('keeps EPERM unknown without an independent identity match', async () => {
    await expect(
      probeDaemonProcessIdentity(
        exactIncarnation,
        endpoint,
        linuxDependencies({
          signalProcess: () => 'permission_denied',
          readLinuxStat: async () => ({ status: 'unavailable' })
        })
      )
    ).resolves.toMatchObject({ state: 'unknown', reason: 'permission_denied' })
  })

  it('keeps a missing proc stat unknown when signal zero still sees the pid', async () => {
    await expect(
      probeDaemonProcessIdentity(
        exactIncarnation,
        endpoint,
        linuxDependencies({
          readLinuxStat: async () => ({ status: 'missing' })
        })
      )
    ).resolves.toMatchObject({ state: 'unknown', reason: 'inspection_failed' })
  })

  it('keeps an unreadable command line unknown even when Linux start identity matches', async () => {
    await expect(
      probeDaemonProcessIdentity(
        exactIncarnation,
        endpoint,
        linuxDependencies({ readCommandLine: async () => undefined })
      )
    ).resolves.toMatchObject({ state: 'unknown', reason: 'command_line_unavailable' })
  })

  it('never treats signal-zero success alone as present', async () => {
    await expect(
      probeDaemonProcessIdentity(
        { identity: exactIncarnation.identity },
        endpoint,
        linuxDependencies({
          readCommandLine: async () => undefined
        })
      )
    ).resolves.toMatchObject({ state: 'unknown' })
  })

  it('never turns a legacy identity gap into gone', async () => {
    await expect(
      probeDaemonProcessIdentity(null, endpoint, linuxDependencies())
    ).resolves.toMatchObject({ state: 'unknown', reason: 'exact_identity_unavailable' })
  })

  it('uses Windows CreationDate as the primary identity regardless of command line', async () => {
    const base = {
      platform: 'win32' as const,
      signalProcess: () => 'occupied' as const
    }
    await expect(
      probeDaemonProcessIdentity(exactIncarnation, endpoint, {
        ...base,
        queryWindowsProcess: async () => ({
          status: 'present',
          commandLine: 'unreadable',
          startedAtMs:
            exactIncarnation.identity.startedAtMs + WINDOWS_CREATION_TIME_TOLERANCE_MS + 1
        })
      })
    ).resolves.toMatchObject({
      state: 'gone',
      reason: 'windows_creation_time_mismatch'
    })
    await expect(
      probeDaemonProcessIdentity(exactIncarnation, endpoint, {
        ...base,
        queryWindowsProcess: async () => ({
          status: 'present',
          commandLine: null,
          startedAtMs: exactIncarnation.identity.startedAtMs
        })
      })
    ).resolves.toMatchObject({
      state: 'present',
      reason: 'windows_identity_match'
    })
    await expect(
      probeDaemonProcessIdentity(exactIncarnation, endpoint, {
        ...base,
        queryWindowsProcess: async () => ({
          status: 'present',
          commandLine: 'unrelated process',
          startedAtMs: exactIncarnation.identity.startedAtMs
        })
      })
    ).resolves.toMatchObject({
      state: 'present',
      reason: 'windows_identity_match'
    })
    await expect(
      probeDaemonProcessIdentity(exactIncarnation, endpoint, {
        ...base,
        queryWindowsProcess: async () => ({
          status: 'present',
          commandLine: 'node daemon-entry',
          startedAtMs: null
        })
      })
    ).resolves.toMatchObject({
      state: 'unknown',
      reason: 'windows_process_start_time_unavailable'
    })
    await expect(
      probeDaemonProcessIdentity(exactIncarnation, endpoint, {
        ...base,
        queryWindowsProcess: async () => ({ status: 'missing' })
      })
    ).resolves.toMatchObject({
      state: 'gone',
      reason: 'windows_process_missing'
    })
  })

  it('requires Windows CIM evidence even when signal-zero reports a missing pid', async () => {
    await expect(
      probeDaemonProcessIdentity(exactIncarnation, endpoint, {
        platform: 'win32',
        signalProcess: () => 'missing',
        queryWindowsProcess: async () => ({
          status: 'present',
          commandLine: null,
          startedAtMs: exactIncarnation.identity.startedAtMs
        })
      })
    ).resolves.toMatchObject({
      state: 'present',
      reason: 'windows_identity_match'
    })
  })

  it('keeps a macOS lstart mismatch unknown', async () => {
    await expect(
      probeDaemonProcessIdentity(exactIncarnation, endpoint, {
        platform: 'darwin',
        signalProcess: () => 'occupied',
        readCommandLine: async () =>
          `node daemon-entry --socket ${endpoint.socketPath} --token ${endpoint.tokenPath}`,
        readProcessStartedAtMs: async () => exactIncarnation.identity.startedAtMs + 2_500
      })
    ).resolves.toMatchObject({ state: 'unknown', reason: 'macos_start_time_mismatch' })
  })

  it('accepts ESRCH as conclusive POSIX process disappearance', async () => {
    await expect(
      probeDaemonProcessIdentity(exactIncarnation, endpoint, {
        platform: 'darwin',
        signalProcess: () => 'missing'
      })
    ).resolves.toMatchObject({ state: 'gone', reason: 'pid_missing' })
  })

  it('keeps unsupported platforms indeterminate without running a Darwin probe', async () => {
    const signalProcess = vi.fn(() => 'occupied' as const)
    const readCommandLine = vi.fn(async () => 'node daemon-entry')

    await expect(
      probeDaemonProcessIdentity(exactIncarnation, endpoint, {
        platform: 'freebsd',
        signalProcess,
        readCommandLine
      })
    ).resolves.toMatchObject({ state: 'unknown', reason: 'inspection_failed' })
    expect(signalProcess).not.toHaveBeenCalled()
    expect(readCommandLine).not.toHaveBeenCalled()
  })
})

describe('daemon audit availability evidence', () => {
  const context: DaemonAuditContext = {
    protocolGeneration: 23,
    provider: 'local-daemon',
    endpoint: endpoint.socketPath,
    tokenPath: endpoint.tokenPath,
    endpointKind: 'unix-socket',
    profileScope: '/profile'
  }

  it('records authoritative inventory as present without endpoint identity', () => {
    expect(recordAuthenticatedInventory(context, null)).toMatchObject({
      state: 'present',
      reason: 'authenticated_inventory',
      exactIncarnation: null,
      inventoryAuthority: 'authoritative'
    })
  })

  it('represents failed legacy inventory as unknown, never an empty process list', async () => {
    const observation = await classifyDaemonAuditFailure(context, 'inventory_failed', null, {
      dependencies: auditClassifierDependencies
    })

    expect(observation).toMatchObject({
      state: 'unknown',
      reason: 'inventory_failed',
      inventoryAuthority: 'unavailable',
      processLiveness: 'unknown'
    })
    expect(observation.evidenceSources.length).toBeGreaterThan(0)
    expect(observation).not.toHaveProperty('processes')
  })

  it('keeps token removal after disconnect as contributing evidence only', async () => {
    const observation = await classifyDaemonAuditFailure(
      context,
      'token_missing_after_authenticated_disconnect',
      null,
      {
        additionalEvidenceSources: ['token_file'],
        dependencies: auditClassifierDependencies
      }
    )

    expect(observation.state).toBe('unknown')
    expect(observation.evidenceSources).toContain('token_file')
  })

  it('accepts Windows named-pipe absence only with exact incarnation evidence', async () => {
    const windowsContext: DaemonAuditContext = {
      ...context,
      endpoint: '\\\\?\\pipe\\orca-daemon',
      endpointKind: 'windows-named-pipe'
    }
    const observation = await classifyDaemonAuditFailure(
      windowsContext,
      'inventory_failed',
      exactIncarnation,
      {
        additionalEvidenceSources: ['windows_named_pipe'],
        endpointGoneProof: 'windows_named_pipe_missing',
        dependencies: auditClassifierDependencies
      }
    )

    expect(observation).toMatchObject({
      state: 'gone',
      reason: 'windows_named_pipe_missing',
      endpointState: 'missing',
      exactIncarnation
    })
  })

  it('keeps contradictory Windows pipe and process evidence unknown', async () => {
    const windowsContext: DaemonAuditContext = {
      ...context,
      endpoint: '\\\\?\\pipe\\orca-daemon',
      endpointKind: 'windows-named-pipe'
    }
    const dependencies = {
      ...auditClassifierDependencies,
      probeProcessIdentity: async () => ({
        state: 'present',
        reason: 'windows_identity_match',
        evidenceSources: ['windows_cim', 'endpoint_identity']
      })
    } satisfies DaemonAuditClassifierDependencies

    await expect(
      classifyDaemonAuditFailure(windowsContext, 'inventory_failed', exactIncarnation, {
        additionalEvidenceSources: ['windows_named_pipe'],
        endpointGoneProof: 'windows_named_pipe_missing',
        dependencies
      })
    ).resolves.toMatchObject({
      state: 'unknown',
      reason: 'inventory_failed',
      processLiveness: 'present',
      processReason: 'windows_identity_match',
      endpointState: 'missing'
    })
  })

  it('rejects named-pipe disappearance as a gone proof for Unix endpoints', async () => {
    const observation = await classifyDaemonAuditFailure(
      context,
      'inventory_failed',
      exactIncarnation,
      {
        additionalEvidenceSources: ['windows_named_pipe'],
        endpointGoneProof: 'windows_named_pipe_missing',
        dependencies: auditClassifierDependencies
      }
    )

    expect(observation).toMatchObject({
      state: 'unknown',
      reason: 'inventory_failed',
      processLiveness: 'unknown'
    })
  })
})
