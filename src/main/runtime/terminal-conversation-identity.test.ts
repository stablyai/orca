import { describe, expect, it } from 'vitest'
import {
  resolveTerminalConversationIdentity,
  type LegacyIdentityCandidate
} from './terminal-conversation-identity'

const S = { key: 'session_id' as const, id: 'S', transcriptPath: 'C:\\Users\\me\\rollout-S.jsonl' }
const facet = { agentType: 'codex', providerSession: S, model: 'P', capturedAt: 10 }
const legacy: LegacyIdentityCandidate = {
  providerSession: S,
  sessionAgent: 'codex',
  model: 'P',
  capturedAt: 20,
  source: 'legacy-row'
}
const launchOwner = { ownerIsLaunch: true }

describe('resolveTerminalConversationIdentity', () => {
  it('publishes a compatible facet, with its source from the row', () => {
    for (const rowIsRemnant of [false, true]) {
      expect(
        resolveTerminalConversationIdentity({
          stored: { facet, rowAgent: 'codex', rowIsRemnant },
          legacy,
          ownerAgent: 'codex',
          ownerOptions: launchOwner,
          foregroundAgent: null
        })
      ).toEqual({ ...facet, source: rowIsRemnant ? 'retained' : 'live' })
    }
  })

  it('names a compatible launch owner as the agent', () => {
    for (const rowAgent of ['pi', 'omp', null]) {
      expect(
        resolveTerminalConversationIdentity({
          stored: { facet: { ...facet, agentType: 'pi' }, rowAgent, rowIsRemnant: false },
          legacy: null,
          ownerAgent: 'omp',
          ownerOptions: launchOwner,
          foregroundAgent: null
        })
      ).toMatchObject({ agentType: 'omp', providerSession: S })
    }
  })

  it("publishes a hand-started agent's facet in a pane launched as another agent", () => {
    expect(
      resolveTerminalConversationIdentity({
        stored: { facet, rowAgent: 'codex', rowIsRemnant: false },
        legacy,
        ownerAgent: 'claude',
        ownerOptions: launchOwner,
        foregroundAgent: null
      })
    ).toEqual({ ...facet, source: 'live' })
  })

  it("withholds (absent, never null) a facet of another agent than the row's, whatever the owner", () => {
    for (const ownerAgent of [null, 'claude']) {
      expect(
        resolveTerminalConversationIdentity({
          stored: {
            facet: { ...facet, agentType: 'claude' },
            rowAgent: 'amp',
            rowIsRemnant: false
          },
          legacy,
          ownerAgent,
          ownerOptions: { ownerIsLaunch: ownerAgent !== null },
          foregroundAgent: null
        })
      ).toBeUndefined()
    }
  })

  it('checks a facet against the owner when the row names no agent, never falling back to legacy', () => {
    expect(
      resolveTerminalConversationIdentity({
        stored: { facet, rowAgent: null, rowIsRemnant: false },
        legacy,
        ownerAgent: 'claude',
        ownerOptions: launchOwner,
        foregroundAgent: null
      })
    ).toBeUndefined()
    expect(
      resolveTerminalConversationIdentity({
        stored: { facet, rowAgent: null, rowIsRemnant: false },
        legacy,
        ownerAgent: null,
        ownerOptions: { ownerIsLaunch: false },
        foregroundAgent: null
      })
    ).toEqual({ ...facet, source: 'live' })
  })

  describe('current-agent evidence', () => {
    const claudeFacet = { ...facet, agentType: 'claude' }
    const resolve = (args: {
      rowAgent: string | null
      rowIsRemnant: boolean
      foregroundAgent: string | null
      ownerAgent?: string | null
      facetAgent?: string
    }) =>
      resolveTerminalConversationIdentity({
        stored: {
          facet: { ...facet, agentType: args.facetAgent ?? 'claude' },
          rowAgent: args.rowAgent,
          rowIsRemnant: args.rowIsRemnant
        },
        legacy: null,
        ownerAgent: args.ownerAgent ?? null,
        ownerOptions: { ownerIsLaunch: false },
        foregroundAgent: args.foregroundAgent
      })

    it("withholds an exited agent's facet from the hand-started agent now in the foreground", () => {
      // Certified exit and dismissal both leave a remnant; an unobserved exit leaves the live row.
      for (const { rowIsRemnant, foregroundAgent } of [
        { rowIsRemnant: true, foregroundAgent: 'aider' },
        { rowIsRemnant: false, foregroundAgent: 'gemini' }
      ]) {
        for (const ownerAgent of [null, 'claude']) {
          expect(
            resolve({ rowAgent: 'claude', rowIsRemnant, foregroundAgent, ownerAgent })
          ).toBeUndefined()
        }
      }
    })

    it("withholds a remnant's facet from a different agent Orca launched before it reports", () => {
      expect(
        resolveTerminalConversationIdentity({
          stored: { facet: claudeFacet, rowAgent: 'claude', rowIsRemnant: true },
          legacy: null,
          ownerAgent: 'codex',
          ownerOptions: launchOwner,
          foregroundAgent: null
        })
      ).toBeUndefined()
    })

    it('keeps publishing when the live row and the foreground both name the facet agent', () => {
      expect(
        resolve({ rowAgent: 'claude', rowIsRemnant: false, foregroundAgent: 'claude' })
      ).toEqual({ ...claudeFacet, source: 'live' })
      expect(
        resolve({ rowAgent: 'claude', rowIsRemnant: true, foregroundAgent: 'claude' })
      ).toEqual({ ...claudeFacet, source: 'retained' })
    })

    it("publishes a hand-started agent's facet beside its foreground in a pane launched as another agent", () => {
      expect(
        resolveTerminalConversationIdentity({
          stored: { facet, rowAgent: 'codex', rowIsRemnant: false },
          legacy: null,
          ownerAgent: 'claude',
          ownerOptions: launchOwner,
          foregroundAgent: 'codex'
        })
      ).toEqual({ ...facet, source: 'live' })
    })

    it('reads a hand-run Agent Teams foreground as the Claude its hooks report', () => {
      expect(
        resolve({ rowAgent: 'claude', rowIsRemnant: false, foregroundAgent: 'claude-agent-teams' })
      ).toEqual({ ...claudeFacet, source: 'live' })
    })

    it('treats an OMP pane and a Pi foreground as one compatible agent', () => {
      for (const { rowAgent, foregroundAgent, facetAgent } of [
        { rowAgent: 'omp', foregroundAgent: 'pi', facetAgent: 'omp' },
        { rowAgent: 'pi', foregroundAgent: 'omp', facetAgent: 'pi' },
        { rowAgent: null, foregroundAgent: 'pi', facetAgent: 'omp' }
      ]) {
        expect(
          resolve({ rowAgent, rowIsRemnant: false, foregroundAgent, facetAgent })
        ).toMatchObject({ providerSession: S })
      }
    })

    it('names the current agent when the launch owner is in another compatible group', () => {
      expect(
        resolveTerminalConversationIdentity({
          stored: { facet: { ...facet, agentType: 'pi' }, rowAgent: 'omp', rowIsRemnant: false },
          legacy: null,
          ownerAgent: 'claude',
          ownerOptions: launchOwner,
          foregroundAgent: null
        })
      ).toMatchObject({ agentType: 'omp', providerSession: S })
    })
  })

  it('falls back to the legacy row only when the store holds no facet', () => {
    expect(
      resolveTerminalConversationIdentity({
        stored: undefined,
        legacy,
        ownerAgent: null,
        ownerOptions: { ownerIsLaunch: false },
        foregroundAgent: null
      })
    ).toEqual({
      agentType: 'codex',
      providerSession: S,
      model: 'P',
      capturedAt: 20,
      source: 'legacy-row'
    })
  })

  it('publishes nothing when there is no usable evidence', () => {
    for (const args of [
      { legacy: null, ownerAgent: 'codex' },
      { legacy: { ...legacy, sessionAgent: null }, ownerAgent: null },
      { legacy, ownerAgent: 'claude' }
    ]) {
      expect(
        resolveTerminalConversationIdentity({
          stored: undefined,
          ownerOptions: launchOwner,
          foregroundAgent: null,
          ...args
        })
      ).toBeUndefined()
    }
  })
})
