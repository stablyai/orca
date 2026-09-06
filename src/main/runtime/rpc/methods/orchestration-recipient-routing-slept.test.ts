/**
 * A slept agent stays addressable through its durable Run/Dispatch mailbox;
 * a terminal-only address must fail because no resumed reader can consume it.
 */
import { describe, expect, it } from 'vitest'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { resolveBareOrchestrationRecipient } from './orchestration-recipient-routing'

const HANDLE = 'term_slept'
const PANE_KEY = 'tab-1:leaf-1'

function runtimeWith(
  sleptPane: { paneKey: string; autoWakes: boolean } | null
): OrcaRuntimeService {
  return {
    getLiveTerminalPaneKey: () => null,
    getResumableSleptRecipientPane: () => sleptPane
  } as unknown as OrcaRuntimeService
}

function dbWith(overrides: Partial<OrchestrationDb> = {}): OrchestrationDb {
  return {
    getCurrentRunForPane: () => undefined,
    getActiveDispatchMailboxOwners: () => [],
    getRunMailboxOwnerIdsForHandle: () => [],
    ...overrides
  } as unknown as OrchestrationDb
}

describe('sending to a slept recipient', () => {
  it('routes to the run its slept coordinator pane owns', () => {
    const resolution = resolveBareOrchestrationRecipient({
      runtime: runtimeWith({ paneKey: PANE_KEY, autoWakes: true }),
      db: dbWith({
        getCurrentRunForPane: ((paneKey: string) =>
          paneKey === PANE_KEY ? { id: 'run-1' } : undefined) as never
      }),
      handle: HANDLE
    })
    expect(resolution).toMatchObject({ ok: true, to: 'run:run-1', runId: 'run-1' })
    expect(resolution.warning).toMatchObject({ code: 'recipient_asleep' })
    expect(resolution.warning?.message).toContain('will be woken')
  })

  it('tells the sender a deliberately slept pane is never woken automatically', () => {
    const resolution = resolveBareOrchestrationRecipient({
      runtime: runtimeWith({ paneKey: PANE_KEY, autoWakes: false }),
      db: dbWith({ getCurrentRunForPane: (() => ({ id: 'run-1' })) as never }),
      handle: HANDLE
    })
    expect(resolution.warning?.message).toContain('next opened')
    expect(resolution.ok).toBe(true)
  })

  it('refuses a slept terminal-only mailbox that no resumed agent can read', () => {
    const resolution = resolveBareOrchestrationRecipient({
      runtime: runtimeWith({ paneKey: PANE_KEY, autoWakes: true }),
      db: dbWith(),
      handle: HANDLE
    })
    expect(resolution).toMatchObject({
      ok: false,
      code: 'terminal_not_found',
      warning: { code: 'recipient_unreachable' }
    })
    if (resolution.ok) {
      throw new Error('expected slept terminal-only recipient to be rejected')
    }
    expect(resolution.message).toContain('no durable Run/Dispatch mailbox')
  })

  it('still refuses a handle that resolves to no pane at all', () => {
    const resolution = resolveBareOrchestrationRecipient({
      runtime: runtimeWith(null),
      db: dbWith(),
      handle: 'term_gone'
    })
    expect(resolution).toMatchObject({ ok: false, code: 'terminal_not_found' })
  })

  it('leaves a live recipient unannotated', () => {
    const runtime = {
      getLiveTerminalPaneKey: () => PANE_KEY,
      getResumableSleptRecipientPane: () => {
        throw new Error('must not consult sleeping records for a live pane')
      }
    } as unknown as OrcaRuntimeService
    const resolution = resolveBareOrchestrationRecipient({
      runtime,
      db: dbWith({ getCurrentRunForPane: (() => ({ id: 'run-1' })) as never }),
      handle: HANDLE
    })
    expect(resolution).toEqual({ ok: true, to: 'run:run-1', runId: 'run-1' })
  })

  it('tolerates a runtime that predates the slept-recipient lookup', () => {
    const runtime = { getLiveTerminalPaneKey: () => null } as unknown as OrcaRuntimeService
    expect(
      resolveBareOrchestrationRecipient({ runtime, db: dbWith(), handle: HANDLE })
    ).toMatchObject({ ok: false, code: 'terminal_not_found' })
  })
})
