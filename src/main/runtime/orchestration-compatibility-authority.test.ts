import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { OrcaRuntimeService } from './orca-runtime'

const PANE_KEY = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'
const TOKEN = 'launch-secret'
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex')

type TerminalAuthorityResolver = {
  getOrchestrationDispatchAuthority: (terminalHandle: string) => unknown
  restoredOrchestrationAuthorityByPtyId: Map<string, Record<string, unknown>>
}

function createRuntime(
  hostScope:
    | { kind: 'local'; hostId: 'local' }
    | { kind: 'wsl'; hostId: 'local'; distro: string }
    | { kind: 'ssh'; targetId: string },
  launchTokenHash: string | null = TOKEN_HASH
) {
  const runtime = new OrcaRuntimeService(null, undefined, {
    attestAgentHookCompatibilityAuthority: ({ paneKey, launchTokenHash, connectionId }) =>
      paneKey === PANE_KEY &&
      launchTokenHash === TOKEN_HASH &&
      connectionId === (hostScope.kind === 'ssh' ? hostScope.targetId : null)
        ? { paneKey, source: 'hydrated_commitment' }
        : null
  })
  const resolveTerminal = vi.fn(() => ({
    runtimeId: 'runtime-1',
    terminalHandle: 'term-1',
    ptyId: 'pty-1',
    worktreeId: 'repo-1::/worktree',
    processIncarnation: 'incarnation-1',
    paneKey: PANE_KEY,
    launchTokenHash,
    hostScope
  }))
  ;(runtime as unknown as TerminalAuthorityResolver).getOrchestrationDispatchAuthority =
    resolveTerminal
  if (launchTokenHash === null) {
    ;(runtime as unknown as TerminalAuthorityResolver).restoredOrchestrationAuthorityByPtyId.set(
      'pty-1',
      {
        ptyId: 'pty-1',
        worktreeId: 'repo-1::/worktree',
        terminalHandle: 'term-1',
        paneKey: PANE_KEY,
        processIncarnation: 'incarnation-1',
        hostScope
      }
    )
  }
  return runtime
}

describe('orchestration compatibility runtime authority', () => {
  it('returns only attested local identity and its token hash', () => {
    const runtime = createRuntime({ kind: 'local', hostId: 'local' })

    const authority = runtime.verifyOrchestrationCompatibilityCaller({
      terminalHandle: 'term-1',
      paneKey: PANE_KEY,
      launchToken: TOKEN
    })

    expect(authority).toEqual({
      hostScope: { kind: 'local', hostId: 'local' },
      paneKey: PANE_KEY,
      terminalHandle: 'term-1',
      processIncarnation: 'incarnation-1',
      launchTokenHash: TOKEN_HASH
    })
    expect(JSON.stringify(authority)).not.toContain(TOKEN)
    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: 'term-1',
        paneKey: PANE_KEY,
        launchToken: 'wrong'
      })
    ).toBeNull()
    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: 'term-1',
        paneKey: PANE_KEY,
        launchToken: TOKEN_HASH
      })
    ).toBeNull()
  })

  it('keeps local and WSL authority stable across app runtime generations', () => {
    const firstLocal = createRuntime({ kind: 'local', hostId: 'local' })
    const secondLocal = createRuntime({ kind: 'local', hostId: 'local' })
    const wsl = createRuntime({ kind: 'wsl', hostId: 'local', distro: 'Ubuntu' })
    const localEvidence = {
      terminalHandle: 'term-1',
      paneKey: PANE_KEY,
      launchToken: TOKEN
    }
    const wslEvidence = {
      ...localEvidence,
      host: { kind: 'wsl', hostId: 'local', distro: 'Ubuntu' }
    } as const

    expect(firstLocal.verifyOrchestrationCompatibilityCaller(localEvidence)?.hostScope).toEqual(
      secondLocal.verifyOrchestrationCompatibilityCaller(localEvidence)?.hostScope
    )
    expect(wsl.verifyOrchestrationCompatibilityCaller(wslEvidence)?.hostScope).toEqual({
      kind: 'wsl',
      hostId: 'local',
      distro: 'Ubuntu'
    })
    expect(wsl.verifyOrchestrationCompatibilityCaller(localEvidence)).toBeNull()
    expect(
      wsl.verifyOrchestrationCompatibilityCaller({
        ...wslEvidence,
        host: { kind: 'wsl', hostId: 'runtime-before-restart', distro: 'Ubuntu' }
      })
    ).toBeNull()
  })

  it('requires a live exact terminal even when the hook proof is hydrated', () => {
    const runtime = createRuntime({ kind: 'local', hostId: 'local' })
    ;(runtime as unknown as TerminalAuthorityResolver).getOrchestrationDispatchAuthority = () =>
      null

    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: 'term-1',
        paneKey: PANE_KEY,
        launchToken: TOKEN
      })
    ).toBeNull()
  })

  it('uses the hydrated hook commitment for a restored exact PTY', () => {
    const restored = createRuntime({ kind: 'local', hostId: 'local' }, null)
    const uncommitted = new OrcaRuntimeService()
    ;(uncommitted as unknown as TerminalAuthorityResolver).getOrchestrationDispatchAuthority =
      () => ({
        runtimeId: 'runtime-1',
        terminalHandle: 'term-1',
        ptyId: 'pty-1',
        worktreeId: 'repo-1::/worktree',
        processIncarnation: 'incarnation-1',
        paneKey: PANE_KEY,
        launchTokenHash: null,
        hostScope: { kind: 'local', hostId: 'local' }
      })
    const evidence = {
      terminalHandle: 'term-1',
      paneKey: PANE_KEY,
      launchToken: TOKEN
    }

    expect(restored.verifyOrchestrationCompatibilityCaller(evidence)).toMatchObject({
      processIncarnation: 'incarnation-1',
      launchTokenHash: TOKEN_HASH
    })
    expect(uncommitted.verifyOrchestrationCompatibilityCaller(evidence)).toBeNull()
    expect(
      restored.verifyOrchestrationCompatibilityCaller({
        ...evidence,
        launchToken: 'wrong'
      })
    ).toBeNull()
  })

  it.each([
    ['PTY', { ptyId: 'pty-other' }],
    ['worktree', { worktreeId: 'repo-1::/other' }],
    ['terminal handle', { terminalHandle: 'term-other' }],
    [
      'pane',
      { paneKey: '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444' }
    ],
    ['process incarnation', { processIncarnation: 'incarnation-other' }]
  ])('rejects a restored receipt with mismatched %s identity', (_field, mismatch) => {
    const runtime = createRuntime({ kind: 'local', hostId: 'local' }, null)
    const internals = runtime as unknown as TerminalAuthorityResolver
    const receipt = internals.restoredOrchestrationAuthorityByPtyId.get('pty-1')!
    internals.restoredOrchestrationAuthorityByPtyId.set('pty-1', { ...receipt, ...mismatch })

    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: 'term-1',
        paneKey: PANE_KEY,
        launchToken: TOKEN
      })
    ).toBeNull()
  })

  it('rejects restored receipts from a different WSL distro or SSH target', () => {
    const wsl = createRuntime({ kind: 'wsl', hostId: 'local', distro: 'Ubuntu' }, null)
    const wslInternals = wsl as unknown as TerminalAuthorityResolver
    const wslReceipt = wslInternals.restoredOrchestrationAuthorityByPtyId.get('pty-1')!
    wslInternals.restoredOrchestrationAuthorityByPtyId.set('pty-1', {
      ...wslReceipt,
      hostScope: { kind: 'wsl', hostId: 'local', distro: 'Debian' }
    })
    expect(
      wsl.verifyOrchestrationCompatibilityCaller({
        terminalHandle: 'term-1',
        paneKey: PANE_KEY,
        launchToken: TOKEN,
        host: { kind: 'wsl', hostId: 'local', distro: 'Ubuntu' }
      })
    ).toBeNull()

    const ssh = createRuntime({ kind: 'ssh', targetId: 'saved-target' }, null)
    const sshInternals = ssh as unknown as TerminalAuthorityResolver
    const sshReceipt = sshInternals.restoredOrchestrationAuthorityByPtyId.get('pty-1')!
    sshInternals.restoredOrchestrationAuthorityByPtyId.set('pty-1', {
      ...sshReceipt,
      hostScope: { kind: 'ssh', targetId: 'other-target' }
    })
    const host = ssh.registerOrchestrationCompatibilitySshAttachment('saved-target', 'connection-1')
    expect(
      ssh.verifyOrchestrationCompatibilityCaller({
        terminalHandle: 'term-1',
        paneKey: PANE_KEY,
        launchToken: TOKEN,
        host
      })
    ).toBeNull()
  })

  it('does not fall back to a restored receipt when a fresh launch token mismatches', () => {
    const runtime = createRuntime({ kind: 'local', hostId: 'local' })
    ;(runtime as unknown as TerminalAuthorityResolver).restoredOrchestrationAuthorityByPtyId.set(
      'pty-1',
      {
        ptyId: 'pty-1',
        worktreeId: 'repo-1::/worktree',
        terminalHandle: 'term-1',
        paneKey: PANE_KEY,
        processIncarnation: 'incarnation-1',
        hostScope: { kind: 'local', hostId: 'local' }
      }
    )

    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: 'term-1',
        paneKey: PANE_KEY,
        launchToken: 'wrong'
      })
    ).toBeNull()
  })

  it('attests current coordinators immediately without upgrading restored legacy callers', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        launchToken: TOKEN,
        payload: { state: 'working', prompt: 'coordinate', agentType: 'codex' }
      },
      'saved-target'
    )
    const createIntegratedRuntime = (launchTokenHash: string | null): OrcaRuntimeService => {
      const runtime = new OrcaRuntimeService(null, undefined, {
        attestAgentHookCompatibilityAuthority: (candidate) =>
          server.attestCompatibilityAuthority(candidate)
      })
      ;(runtime as unknown as TerminalAuthorityResolver).getOrchestrationDispatchAuthority = vi.fn(
        () => ({
          runtimeId: 'runtime-1',
          terminalHandle: 'term-1',
          ptyId: 'pty-1',
          worktreeId: 'repo-1::/worktree',
          processIncarnation: 'incarnation-1',
          paneKey: PANE_KEY,
          launchTokenHash,
          hostScope: { kind: 'ssh', targetId: 'saved-target' }
        })
      )
      if (launchTokenHash === null) {
        ;(
          runtime as unknown as TerminalAuthorityResolver
        ).restoredOrchestrationAuthorityByPtyId.set('pty-1', {
          ptyId: 'pty-1',
          worktreeId: 'repo-1::/worktree',
          terminalHandle: 'term-1',
          paneKey: PANE_KEY,
          processIncarnation: 'incarnation-1',
          hostScope: { kind: 'ssh', targetId: 'saved-target' }
        })
      }
      return runtime
    }
    const evidenceFor = (runtime: OrcaRuntimeService, launchToken = TOKEN) => ({
      terminalHandle: 'term-1',
      paneKey: PANE_KEY,
      launchToken,
      host: runtime.registerOrchestrationCompatibilitySshAttachment('saved-target', 'connection-1')
    })

    const current = createIntegratedRuntime(TOKEN_HASH)
    expect(current.verifyOrchestrationCompatibilityCaller(evidenceFor(current))).not.toBeNull()

    const restored = createIntegratedRuntime(null)
    expect(restored.verifyOrchestrationCompatibilityCaller(evidenceFor(restored))).toBeNull()

    server.ingestRemote(
      {
        paneKey: '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444',
        launchToken: TOKEN,
        payload: { state: 'working', prompt: 'duplicate', agentType: 'codex' }
      },
      'saved-target'
    )
    expect(current.verifyOrchestrationCompatibilityCaller(evidenceFor(current))).toBeNull()

    const mismatchedToken = 'different-launch-secret'
    const mismatched = createIntegratedRuntime(
      createHash('sha256').update(mismatchedToken).digest('hex')
    )
    expect(
      mismatched.verifyOrchestrationCompatibilityCaller(evidenceFor(mismatched, mismatchedToken))
    ).toBeNull()
  })

  it('accepts only a live runtime-issued SSH attachment', () => {
    const runtime = createRuntime({ kind: 'ssh', targetId: 'saved-target' })
    const host = runtime.registerOrchestrationCompatibilitySshAttachment(
      'saved-target',
      'connection-1'
    )
    const evidence = {
      terminalHandle: 'term-1',
      paneKey: PANE_KEY,
      launchToken: TOKEN,
      host
    } as const

    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).not.toBeNull()
    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        ...evidence,
        host: { ...host, attachmentId: 'caller-chosen' }
      })
    ).toBeNull()

    runtime.releaseOrchestrationCompatibilitySshAttachment(host.attachmentId)

    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).toBeNull()
  })
})
