import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeTerminalIdentityProofComplete,
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../shared/runtime-terminal-contracts'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  TerminalIdentityProofCandidate,
  TerminalIdentityProofChallenge,
  TerminalIdentityProofDelta
} from './terminal-identity-proof-ledger'
import {
  isSoleLiveTerminalLeafInTab,
  TerminalIdentityProofService,
  type TerminalIdentityProofLeafObservation,
  type TerminalIdentityProofHost
} from './terminal-identity-proof-service'

const WORKTREE_ID = 'repo::/worktree'
const EXECUTION_HOST_ID: ExecutionHostId = 'local'

function terminal(id: number): RuntimeTerminalSummary {
  return {
    handle: `term-${id}`,
    ptyId: `pty-${id}`,
    incarnationId: `inc-${id}`,
    worktreeId: WORKTREE_ID,
    worktreePath: '/worktree',
    branch: 'main',
    tabId: `tab-${id}`,
    leafId: `leaf-${id}`,
    title: null,
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    executionHostId: EXECUTION_HOST_ID
  }
}

function candidate(value: RuntimeTerminalSummary): TerminalIdentityProofCandidate {
  return {
    handle: value.handle,
    ptyId: value.ptyId!,
    incarnationId: value.incarnationId!,
    tabId: value.tabId,
    leafId: value.leafId,
    generation: 1,
    cursor: 0
  }
}

function proofDelta(streamLines: string[], screenLines: string[] = []): TerminalIdentityProofDelta {
  return {
    stream: { lines: streamLines, truncated: false, limited: false },
    screen: { lines: screenLines }
  }
}

describe('TerminalIdentityProofService', () => {
  let listed: RuntimeTerminalListResult
  let current: boolean
  let deltas: Map<string, TerminalIdentityProofDelta>
  let names: Map<string, string | null>
  let liveLeaves: TerminalIdentityProofLeafObservation[]
  let afterDeltaRead: ((candidate: TerminalIdentityProofCandidate) => void) | null
  let afterListCurrentNames: (() => void) | null
  let isCandidateEligible: ReturnType<
    typeof vi.fn<TerminalIdentityProofHost['isCandidateEligible']>
  >
  let captureCandidate: ReturnType<typeof vi.fn<TerminalIdentityProofHost['captureCandidate']>>
  let renameCandidate: ReturnType<typeof vi.fn<TerminalIdentityProofHost['renameCandidate']>>
  let service: TerminalIdentityProofService

  beforeEach(() => {
    listed = {
      terminals: [terminal(1), terminal(2)],
      topologyRevisions: { [WORKTREE_ID]: 7 },
      hostScope: { hostIds: [EXECUTION_HOST_ID], omittedHostIds: [] },
      totalCount: 2,
      truncated: false
    }
    current = true
    deltas = new Map()
    names = new Map([
      ['pty-1', null],
      ['pty-2', null]
    ])
    liveLeaves = listed.terminals.map((value) => ({
      tabId: value.tabId,
      leafId: value.leafId,
      ptyId: value.ptyId,
      connected: value.connected
    }))
    afterDeltaRead = null
    afterListCurrentNames = null
    isCandidateEligible = vi.fn((_worktreeId, value) =>
      liveLeaves.some((leaf) => leaf.ptyId === value.ptyId)
    )
    captureCandidate = vi.fn((_worktreeId, _executionHostId, value) => {
      const captured = candidate(value)
      return current && isSoleLiveTerminalLeafInTab(captured, liveLeaves) ? captured : null
    })
    renameCandidate = vi.fn<TerminalIdentityProofHost['renameCandidate']>(
      (
        challenge: TerminalIdentityProofChallenge,
        matched: TerminalIdentityProofCandidate,
        title: string
      ): RuntimeTerminalIdentityProofComplete => {
        names.set(matched.ptyId, title)
        return {
          rename: { handle: matched.handle, tabId: matched.tabId, title },
          binding: {
            handle: matched.handle,
            worktreeId: challenge.worktreeId,
            tabId: matched.tabId,
            leafId: matched.leafId,
            ptyId: matched.ptyId,
            incarnationId: matched.incarnationId,
            executionHostId: challenge.executionHostId,
            topologyRevision: challenge.topologyRevision
          }
        }
      }
    )
    const host: TerminalIdentityProofHost = {
      runtimeId: 'runtime-1',
      resolveWorktreeId: vi.fn(async () => WORKTREE_ID),
      listTerminals: vi.fn(async () => listed),
      getWorkspaceExecutionHostId: vi.fn(() => EXECUTION_HOST_ID),
      getTopologyRevision: vi.fn(() => listed.topologyRevisions?.[WORKTREE_ID] ?? -1),
      isCandidateEligible,
      captureCandidate,
      isCandidateCurrent: vi.fn(
        (_worktreeId, value) => current && isSoleLiveTerminalLeafInTab(value, liveLeaves)
      ),
      readDelta: vi.fn(async (value) => {
        const delta = deltas.get(value.ptyId) ?? null
        afterDeltaRead?.(value)
        return delta
      }),
      listCurrentNames: vi.fn((_worktreeId, exceptPtyId) => {
        const currentNames = [...names.entries()]
          .filter(([ptyId]) => ptyId !== exceptPtyId)
          .map(([, name]) => name)
        afterListCurrentNames?.()
        return currentNames
      }),
      renameCandidate
    }
    service = new TerminalIdentityProofService(host)
  })

  it('matches a marker visible only in the Runtime-acquired current screen and renames', async () => {
    const proof = await service.begin(`id:${WORKTREE_ID}`)
    deltas.set('pty-1', proofDelta([], [proof.marker]))
    deltas.set('pty-2', proofDelta([]))

    const completed = await service.complete(proof.challengeId, ' agent-one ')

    expect(completed.rename).toEqual({ handle: 'term-1', tabId: 'tab-1', title: 'agent-one' })
    expect(completed.binding).toMatchObject({
      ptyId: 'pty-1',
      incarnationId: 'inc-1',
      executionHostId: EXECUTION_HOST_ID,
      topologyRevision: 7
    })
  })

  it('ignores unsupported PTY-only records before freezing the visible candidate set', async () => {
    liveLeaves = liveLeaves.filter((leaf) => leaf.ptyId !== 'pty-2')

    const proof = await service.begin(`id:${WORKTREE_ID}`)
    deltas.set('pty-1', proofDelta([], [proof.marker]))

    await expect(service.complete(proof.challengeId, 'agent-one')).resolves.toBeDefined()
    expect(captureCandidate).toHaveBeenCalledTimes(1)
    expect(captureCandidate).toHaveBeenCalledWith(WORKTREE_ID, EXECUTION_HOST_ID, terminal(1))
  })

  it('filters another execution host before candidate eligibility and capture', async () => {
    const foreign = { ...terminal(3), executionHostId: 'ssh:other-host' as ExecutionHostId }
    listed.terminals = [...listed.terminals, foreign]
    listed.totalCount = 3
    liveLeaves.push({
      tabId: foreign.tabId,
      leafId: foreign.leafId,
      ptyId: foreign.ptyId,
      connected: true
    })

    const proof = await service.begin(`id:${WORKTREE_ID}`)

    expect(proof.executionHostId).toBe(EXECUTION_HOST_ID)
    expect(isCandidateEligible).toHaveBeenCalledTimes(2)
    expect(captureCandidate).toHaveBeenCalledTimes(2)
  })

  it('enforces the candidate cap before capturing terminal state', async () => {
    listed.terminals = Array.from({ length: 65 }, (_, index) => terminal(index + 1))
    listed.totalCount = listed.terminals.length
    liveLeaves = listed.terminals.map((value) => ({
      tabId: value.tabId,
      leafId: value.leafId,
      ptyId: value.ptyId,
      connected: value.connected
    }))

    await expect(service.begin(`id:${WORKTREE_ID}`)).rejects.toThrow(
      'terminal_identity_proof_capacity'
    )
    expect(captureCandidate).not.toHaveBeenCalled()
  })

  it.each([
    ['truncated inventory', () => (listed.truncated = true)],
    ['missing host scope', () => (listed.hostScope = undefined)],
    [
      'partial host scope',
      () =>
        (listed.hostScope = { hostIds: [EXECUTION_HOST_ID], omittedHostIds: [EXECUTION_HOST_ID] })
    ],
    [
      'scope omitting another known host',
      () =>
        (listed.hostScope = {
          hostIds: [EXECUTION_HOST_ID],
          omittedHostIds: ['ssh:other-host']
        })
    ],
    [
      'malformed host scope arrays',
      () =>
        (listed.hostScope = {
          hostIds: [EXECUTION_HOST_ID]
        } as RuntimeTerminalListResult['hostScope'])
    ],
    ['missing topology revision', () => (listed.topologyRevisions = undefined)]
  ])('rejects begin with unverifiable %s', async (_label, mutate) => {
    mutate()
    await expect(service.begin(`id:${WORKTREE_ID}`)).rejects.toThrow(
      'terminal_identity_proof_unverifiable'
    )
  })

  it('consumes the challenge and rejects a changed topology before reading transcript data', async () => {
    const proof = await service.begin(`id:${WORKTREE_ID}`)
    listed.topologyRevisions = { [WORKTREE_ID]: 8 }

    await expect(service.complete(proof.challengeId, 'agent-one')).rejects.toThrow(
      'terminal_identity_proof_identity_changed'
    )
    await expect(service.complete(proof.challengeId, 'agent-one')).rejects.toThrow(
      'terminal_identity_challenge_not_found'
    )
    expect(renameCandidate).not.toHaveBeenCalled()
  })

  it('rejects complete when any known host is omitted from the fresh scope', async () => {
    const proof = await service.begin(`id:${WORKTREE_ID}`)
    listed.hostScope = {
      hostIds: [EXECUTION_HOST_ID],
      omittedHostIds: ['ssh:other-host']
    }

    await expect(service.complete(proof.challengeId, 'agent-one')).rejects.toThrow(
      'terminal_identity_proof_unverifiable'
    )
    expect(renameCandidate).not.toHaveBeenCalled()
  })

  it('binds begin and complete to the authenticated caller when available', async () => {
    const proof = await service.begin(`id:${WORKTREE_ID}`, 'caller-a')

    await expect(service.complete(proof.challengeId, 'agent-one', 'caller-b')).rejects.toThrow(
      'terminal_identity_proof_identity_changed'
    )
    expect(renameCandidate).not.toHaveBeenCalled()
  })

  it('rejects C1 control characters in titles before consuming the challenge', async () => {
    const proof = await service.begin(`id:${WORKTREE_ID}`)
    deltas.set('pty-1', proofDelta([proof.marker]))
    deltas.set('pty-2', proofDelta([]))

    await expect(service.complete(proof.challengeId, `agent\u0085name`)).rejects.toThrow(
      'terminal_identity_proof_invalid_name'
    )
    await expect(service.complete(proof.challengeId, 'agent-name')).resolves.toBeDefined()
  })

  it('rejects an incarnation or single-leaf binding change before rename', async () => {
    const proof = await service.begin(`id:${WORKTREE_ID}`)
    deltas.set('pty-1', proofDelta([proof.marker]))
    deltas.set('pty-2', proofDelta([]))
    current = false

    await expect(service.complete(proof.challengeId, 'agent-one')).rejects.toThrow(
      'terminal_identity_proof_identity_changed'
    )
    expect(renameCandidate).not.toHaveBeenCalled()
  })

  it('requires every frozen candidate to remain in the fresh liveness inventory', async () => {
    const proof = await service.begin(`id:${WORKTREE_ID}`)
    listed.terminals = [listed.terminals[0]]
    listed.totalCount = 1

    await expect(service.complete(proof.challengeId, 'agent-one')).rejects.toThrow(
      'terminal_identity_proof_identity_changed'
    )
    expect(renameCandidate).not.toHaveBeenCalled()
  })

  it('fails begin when a candidate tab contains another live terminal leaf', async () => {
    liveLeaves.push({ tabId: 'tab-1', leafId: 'leaf-split', ptyId: 'pty-split', connected: true })

    await expect(service.begin(`id:${WORKTREE_ID}`)).rejects.toThrow(
      'terminal_identity_proof_unverifiable'
    )
  })

  it('fails complete when the proved tab is split before transcript verification', async () => {
    const proof = await service.begin(`id:${WORKTREE_ID}`)
    liveLeaves.push({ tabId: 'tab-1', leafId: 'leaf-split', ptyId: 'pty-split', connected: true })

    await expect(service.complete(proof.challengeId, 'agent-one')).rejects.toThrow(
      'terminal_identity_proof_identity_changed'
    )
    expect(renameCandidate).not.toHaveBeenCalled()
  })

  it('fails the mutation-boundary recheck when the proved tab splits during rename', async () => {
    const proof = await service.begin(`id:${WORKTREE_ID}`)
    deltas.set('pty-1', proofDelta([], [proof.marker]))
    deltas.set('pty-2', proofDelta([]))
    afterListCurrentNames = () => {
      liveLeaves.push({
        tabId: 'tab-1',
        leafId: 'leaf-split',
        ptyId: 'pty-split',
        connected: true
      })
    }

    await expect(service.complete(proof.challengeId, 'agent-one')).rejects.toThrow(
      'terminal_identity_proof_identity_changed'
    )
    expect(renameCandidate).not.toHaveBeenCalled()
  })

  it('requires a visible snapshot for every candidate even when stream has a unique marker', async () => {
    const proof = await service.begin(`id:${WORKTREE_ID}`)
    deltas.set('pty-1', proofDelta([proof.marker]))

    await expect(service.complete(proof.challengeId, 'agent-one')).rejects.toThrow(
      'terminal_identity_proof_unverifiable'
    )
    expect(renameCandidate).not.toHaveBeenCalled()
  })

  it('rejects an incarnation or snapshot-generation change during async reads', async () => {
    const proof = await service.begin(`id:${WORKTREE_ID}`)
    deltas.set('pty-1', proofDelta([], [proof.marker]))
    deltas.set('pty-2', proofDelta([]))
    afterDeltaRead = (value) => {
      if (value.ptyId === 'pty-1') {
        current = false
      }
    }

    await expect(service.complete(proof.challengeId, 'agent-one')).rejects.toThrow(
      'terminal_identity_proof_identity_changed'
    )
    expect(renameCandidate).not.toHaveBeenCalled()
  })

  it('allows only one of two terminals to claim the same name', async () => {
    const first = await service.begin(`id:${WORKTREE_ID}`)
    const second = await service.begin(`id:${WORKTREE_ID}`)
    deltas.set('pty-1', proofDelta([first.marker]))
    deltas.set('pty-2', proofDelta([second.marker]))

    await expect(service.complete(first.challengeId, 'shared-name')).resolves.toBeDefined()
    await expect(service.complete(second.challengeId, 'shared-name')).rejects.toThrow(
      'terminal_identity_proof_name_conflict'
    )
    expect(renameCandidate).toHaveBeenCalledTimes(1)
  })
})
