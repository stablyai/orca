/**
 * Unit tests for Agent Consent RPC methods (P1-1)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AgentConsentStore, setGlobalAgentConsentStore } from '../../agent-consent-store'
import { AGENT_CONSENT_METHODS } from './agent-consent'

describe('Agent Consent RPC Methods', () => {
  let store: AgentConsentStore
  let dir: string
  let recordHandler: unknown

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-agent-consent-rpc-test-'))
    store = new AgentConsentStore(dir)
    setGlobalAgentConsentStore(store)
    recordHandler = AGENT_CONSENT_METHODS.find((m) => m.name === 'agent.consent.record')?.handler
  })

  afterEach(async () => {
    setGlobalAgentConsentStore(null)
    await rm(dir, { recursive: true, force: true })
  })

  describe('agent.consent.record', () => {
    it('records an allow decision, queryable immediately afterwards', () => {
      const handler = recordHandler as (params: unknown) => unknown
      const result = handler({
        sourceAgentType: 'codex',
        targetAgentType: 'pi',
        decision: 'allow'
      }) as any

      expect(result.sourceAgentType).toBe('codex')
      expect(result.targetAgentType).toBe('pi')
      expect(result.decision).toBe('allow')
      expect(typeof result.decidedAt).toBe('number')
      expect(store.query('codex', 'pi')).toBe('allow')
    })

    it('records a deny decision', () => {
      const handler = recordHandler as (params: unknown) => unknown
      handler({ sourceAgentType: 'codex', targetAgentType: 'pi', decision: 'deny' })

      expect(store.query('codex', 'pi')).toBe('deny')
    })

    it('validates params via zod: rejects a decision outside allow|deny', () => {
      const method = AGENT_CONSENT_METHODS.find((m) => m.name === 'agent.consent.record')
      const parseResult = method?.params?.safeParse({
        sourceAgentType: 'codex',
        targetAgentType: 'pi',
        decision: 'maybe'
      })
      expect(parseResult?.success).toBe(false)
    })

    it('validates params via zod: rejects an empty agentType', () => {
      const method = AGENT_CONSENT_METHODS.find((m) => m.name === 'agent.consent.record')
      const parseResult = method?.params?.safeParse({
        sourceAgentType: '',
        targetAgentType: 'pi',
        decision: 'allow'
      })
      expect(parseResult?.success).toBe(false)
    })

    it('a later call overwrites an earlier decision for the same pair, reflected in the broker gate immediately', () => {
      const handler = recordHandler as (params: unknown) => unknown
      handler({ sourceAgentType: 'codex', targetAgentType: 'pi', decision: 'allow' })
      expect(store.query('codex', 'pi')).toBe('allow')

      handler({ sourceAgentType: 'codex', targetAgentType: 'pi', decision: 'deny' })
      expect(store.query('codex', 'pi')).toBe('deny')
    })
  })
})
