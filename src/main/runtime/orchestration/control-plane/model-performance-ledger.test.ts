import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import {
  MODEL_PERFORMANCE_RETENTION_DAYS,
  ModelPerformanceLedger,
  modelPerformanceEntryId,
  type ModelPerformanceEntry
} from './model-performance-ledger'
import type { RouteIdentity } from './route-registry-types'

const NOW = Date.parse('2026-08-27T12:00:00.000Z')
const IDENTITY: RouteIdentity = { agent: 'claude', model: 'opus-5', reasoning: 'high' }

function entry(overrides: Partial<ModelPerformanceEntry> = {}): ModelPerformanceEntry {
  return {
    outcomeId: 'out_1',
    dispatchId: 'ctx_1',
    identity: IDENTITY,
    modelVersion: 'claude-opus-5',
    role: 'builder',
    taskClassification: 'bounded_implementation',
    firstPassResult: 'corrections_required',
    correctionRounds: 1,
    reviewerDefects: 2,
    escapedDefects: 0,
    wallClockMs: 1_800_000,
    toolCalls: 240,
    contextTokensUsed: 320_000,
    providerLimitInterrupted: false,
    rescueIdentity: null,
    provenance: 'observed_runtime',
    recordedAt: new Date(NOW).toISOString(),
    ...overrides
  }
}

describe('CORRECTION 1 scrubbed model-performance ledger', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function ledger(): ModelPerformanceLedger {
    db = new OrchestrationDb(':memory:')
    return new ModelPerformanceLedger(db)
  }

  it('records the measured outcome fields for one route', () => {
    const log = ledger()
    const row = log.record(entry())
    expect(row).toMatchObject({
      route_key: 'claude|opus-5|high',
      model_version: 'claude-opus-5',
      role: 'builder',
      task_classification: 'bounded_implementation',
      first_pass_result: 'corrections_required',
      correction_rounds: 1,
      reviewer_defects: 2,
      escaped_defects: 0,
      wall_clock_ms: 1_800_000,
      tool_calls: 240,
      context_tokens_used: 320_000,
      provider_limit_interrupted: 0,
      provenance: 'observed_runtime'
    })
  })

  it('records a provider-limit interruption and the rescue route separately', () => {
    const log = ledger()
    const row = log.record(
      entry({
        providerLimitInterrupted: true,
        rescueIdentity: { agent: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' }
      })
    )
    expect(row.provider_limit_interrupted).toBe(1)
    expect(row.rescue_route_key).toBe('codex|gpt-5.6-sol|high')
  })

  it('is idempotent per outcome/dispatch/role/route, so a replay never double-counts', () => {
    const log = ledger()
    log.record(entry())
    log.record(entry({ correctionRounds: 3 }))
    const rows = log.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].correction_rounds).toBe(3)
    expect(modelPerformanceEntryId({ outcomeId: 'out_1', dispatchId: 'ctx_1', role: 'builder', identity: IDENTITY })).toBe(
      rows[0].entry_id
    )
  })

  it('keeps a builder record and a reviewer record for the same Dispatch apart', () => {
    const log = ledger()
    log.record(entry())
    log.record(entry({ role: 'reviewer' }))
    expect(log.list()).toHaveLength(2)
  })

  it('has no free-text column a customer artefact or identifier could land in', () => {
    const log = ledger()
    const row = log.record(entry())
    const structuralKeys = new Set([
      'entry_id',
      'recorded_at',
      'route_key',
      'agent',
      'model',
      'model_version',
      'role',
      'task_classification',
      'first_pass_result',
      'correction_rounds',
      'reviewer_defects',
      'escaped_defects',
      'wall_clock_ms',
      'tool_calls',
      'context_tokens_used',
      'provider_limit_interrupted',
      'rescue_route_key',
      'provenance'
    ])
    expect(new Set(Object.keys(row))).toEqual(structuralKeys)
    // No notes/body/summary/transcript column exists to scrub.
    expect(Object.keys(row).some((key) => /note|body|summary|transcript|customer|email/i.test(key))).toBe(
      false
    )
  })

  it('accepts only the two evidence-backed provenance values', () => {
    const log = ledger()
    expect(log.record(entry({ provenance: 'imported_evidence' })).provenance).toBe('imported_evidence')
    expect(() =>
      log.record(entry({ provenance: 'prompt_claim' as ModelPerformanceEntry['provenance'] }))
    ).toThrow()
  })

  it('prunes entries past the retention window and keeps the rest', () => {
    const log = ledger()
    const oldMs = NOW - (MODEL_PERFORMANCE_RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000
    log.record(entry({ dispatchId: 'ctx_old', recordedAt: new Date(oldMs).toISOString() }))
    log.record(entry({ dispatchId: 'ctx_new' }))
    expect(log.prune(NOW)).toBe(1)
    expect(log.list().map((row) => row.entry_id)).toHaveLength(1)
  })

  it('records UNKNOWN-shaped measurements as null rather than inventing a number', () => {
    const log = ledger()
    const row = log.record(
      entry({ wallClockMs: null, toolCalls: null, contextTokensUsed: null, firstPassResult: 'UNKNOWN' })
    )
    expect(row.wall_clock_ms).toBeNull()
    expect(row.tool_calls).toBeNull()
    expect(row.context_tokens_used).toBeNull()
    expect(row.first_pass_result).toBe('UNKNOWN')
  })
})
