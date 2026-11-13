import { describe, expect, it } from 'vitest'
import {
  MAX_AGGREGATED_PTY_PROCESS_LIST_BYTES,
  MAX_AGGREGATED_PTY_PROCESS_LIST_ENTRIES,
  PtyProcessListAdmission
} from './process-list-admission'
import { MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES as MAX_AGGREGATED_PTY_PROCESS_LIST_OWNERS } from '../../../shared/claimed-agent-pty-owner'

describe('PtyProcessListAdmission', () => {
  const evidence = {
    verdict: 'live' as const,
    processName: 'codex',
    authorityGeneration: 'relay-generation',
    observationEpoch: 4,
    capturedAgeMs: 12
  }

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

  it('carries a WSL guest root and rejects a malformed one instead of stripping it', () => {
    const session = {
      id: 'pty',
      cwd: '/',
      title: 'shell',
      wslDistro: 'Ubuntu',
      wslGuestRoot: { pid: 4242, startTime: '0b1d2c3e-4f50-4617-8293-a4b5c6d7e8f9:98765' }
    }
    expect(new PtyProcessListAdmission().admit(session)).toEqual(session)
    expect(() =>
      new PtyProcessListAdmission().admit({ ...session, wslGuestRoot: { pid: 1, startTime: 'x' } })
    ).toThrow('invalid_pty_process_list')
  })

  it('admits diagnostic provenance and rejects malformed routing evidence', () => {
    const session = {
      id: 'pty',
      cwd: '/',
      title: 'shell',
      inventorySourceId: 'source',
      routed: false
    }
    expect(new PtyProcessListAdmission().admit(session)).toEqual(session)
    Reflect.set(session, 'routed', 'yes')
    expect(() => new PtyProcessListAdmission().admit(session)).toThrow('invalid_pty_process_list')
    Reflect.set(session, 'routed', false)
    Reflect.set(session, 'inventorySourceId', 1)
    expect(() => new PtyProcessListAdmission().admit(session)).toThrow('invalid_pty_process_list')
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
