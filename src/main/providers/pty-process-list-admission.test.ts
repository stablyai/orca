import { describe, expect, it, vi } from 'vitest'
import { createEphemeralAgentSessionClaimSigner } from '../runtime/agent-session-claim-identity'
import type { VerifiedAgentDiscovery } from '../../shared/agent-status-verified-discovery'
import {
  MAX_AGGREGATED_PTY_PROCESS_LIST_BYTES,
  MAX_AGGREGATED_PTY_PROCESS_LIST_ENTRIES,
  MAX_AGGREGATED_PTY_PROCESS_LIST_OWNERS,
  PTY_PROCESS_LIST_PROVIDER_BATCH_SIZE,
  PtyProcessListAdmission,
  visitPtyProcessListingsInBatches
} from './pty-process-list-admission'

describe('PtyProcessListAdmission', () => {
  const evidence = {
    verdict: 'live' as const,
    processName: 'codex',
    authorityGeneration: 'relay-generation',
    observationEpoch: 4,
    capturedAgeMs: 12
  }

  it('preserves and clones optional foreground evidence', () => {
    const admission = new PtyProcessListAdmission()
    const admitted = admission.admit({
      id: 'pty-1',
      cwd: '/repo',
      title: 'shell',
      foregroundProcessEvidence: evidence
    })
    expect(admitted.foregroundProcessEvidence).toEqual(evidence)
    expect(admitted.foregroundProcessEvidence).not.toBe(evidence)
  })

  it('preserves and clones only a host-verified discovery contract', () => {
    const signer = createEphemeralAgentSessionClaimSigner('pty-list-admission-test')
    const verified: VerifiedAgentDiscovery = {
      claim: signer.createFreshClaim({
        namespace: {
          machine: 'native:darwin',
          principal: 'uid:1',
          container: 'native',
          providerRoot: 'profile-default:codex'
        },
        agent: 'codex',
        launchIdentity: 'manual-1',
        canonicalWorktreeId: 'repo::/tmp/worktree'
      }),
      surface: {
        worktreeId: 'repo::/tmp/worktree',
        tabId: 'tab-1',
        leafId: '11111111-1111-4111-8111-111111111111',
        terminalHandle: `term_${'a'.repeat(32)}`
      },
      evidence: {
        verdict: 'live',
        processName: 'codex',
        authorityGeneration: 'host-generation-1',
        observationEpoch: 1,
        capturedAgeMs: 0,
        ptyId: 'pty-1',
        ptyIncarnationId: '22222222-2222-4222-8222-222222222222',
        fence: {
          platform: 'posix',
          shellPid: 100,
          shellStartTime: 'shell-start-1',
          tty: '/dev/ttys001',
          foregroundPgid: 200,
          process: { pid: 200, startTime: 'agent-start-1' }
        }
      },
      providerIdentity: {
        agent: 'codex',
        source: 'provider-session',
        session: { key: 'session_id', id: 'codex-session-1' },
        observation: {
          authorityId: 'hooks-1',
          incarnation: 1,
          revision: 1,
          process: { pid: 200, startTime: 'agent-start' }
        }
      },
      ancestry: {
        parent: { pid: 100, startTime: 'shell-start-1' },
        chain: [{ pid: 100, startTime: 'shell-start-1' }],
        relation: 'direct-child'
      },
      process: { pid: 200, startTime: 'agent-start-1', parentPid: 100 }
    }
    const admitted = new PtyProcessListAdmission().admit({
      id: 'pty-1',
      cwd: '/repo',
      title: 'shell',
      verifiedAgentDiscovery: verified
    })
    expect(admitted.verifiedAgentDiscovery).toEqual(verified)
    expect(admitted.verifiedAgentDiscovery).not.toBe(verified)
    expect(admitted.verifiedAgentDiscovery?.evidence).not.toBe(verified.evidence)
  })

  it('rejects malformed foreground evidence instead of stripping it', () => {
    expect(() =>
      new PtyProcessListAdmission().admit({
        id: 'pty-1',
        cwd: '/repo',
        title: 'shell',
        foregroundProcessEvidence: { ...evidence, verdict: 'wat' }
      } as never)
    ).toThrow('invalid_pty_process_list')
  })

  it('strips unknown provider payloads from admitted process metadata', () => {
    const admission = new PtyProcessListAdmission()

    expect(
      admission.admit({
        id: 'pty-1',
        cwd: '/repo',
        title: 'shell',
        unknownPayload: 'x'.repeat(1024 * 1024)
      } as never)
    ).toEqual({ id: 'pty-1', cwd: '/repo', title: 'shell' })
  })

  it('rejects aggregate entry and byte amplification', () => {
    const entryAdmission = new PtyProcessListAdmission()
    for (let index = 0; index < MAX_AGGREGATED_PTY_PROCESS_LIST_ENTRIES; index += 1) {
      entryAdmission.admit({ id: `pty-${index}`, cwd: '', title: 'shell' })
    }
    expect(() => entryAdmission.admit({ id: 'one-more', cwd: '', title: 'shell' })).toThrow(
      'pty_process_list_capacity'
    )

    const byteAdmission = new PtyProcessListAdmission()
    expect(() =>
      byteAdmission.admit({
        id: 'pty-large',
        cwd: 'x'.repeat(MAX_AGGREGATED_PTY_PROCESS_LIST_BYTES),
        title: 'shell'
      })
    ).toThrow('pty_process_list_capacity')

    expect(() =>
      new PtyProcessListAdmission().admit({
        id: 'pty-owner-flood',
        cwd: '',
        title: 'shell',
        agentSessionOwners: Array.from(
          { length: MAX_AGGREGATED_PTY_PROCESS_LIST_OWNERS + 1 },
          () => ({})
        )
      } as never)
    ).toThrow('pty_process_list_capacity')
  })
})

describe('visitPtyProcessListingsInBatches', () => {
  it('never starts more than the bounded provider batch concurrently', async () => {
    let active = 0
    let peak = 0
    const finishes: (() => void)[] = []
    const load = vi.fn(
      async (source: number) =>
        await new Promise<{ id: string; cwd: string; title: string }[]>((resolve) => {
          active += 1
          peak = Math.max(peak, active)
          finishes.push(() => {
            active -= 1
            resolve([{ id: `pty-${source}`, cwd: '', title: 'shell' }])
          })
        })
    )
    const visiting = visitPtyProcessListingsInBatches(
      Array.from({ length: PTY_PROCESS_LIST_PROVIDER_BATCH_SIZE + 1 }, (_, index) => index),
      load,
      () => {}
    )

    await vi.waitFor(() => expect(finishes).toHaveLength(PTY_PROCESS_LIST_PROVIDER_BATCH_SIZE))
    finishes.splice(0).forEach((finish) => finish())
    await vi.waitFor(() => expect(finishes).toHaveLength(1))
    finishes.splice(0).forEach((finish) => finish())
    await visiting

    expect(peak).toBe(PTY_PROCESS_LIST_PROVIDER_BATCH_SIZE)
  })
})
