/**
 * A slept agent stays addressable through its durable Run/Dispatch mailbox;
 * a terminal-only address must fail because no resumed reader can consume it.
 */
import { describe, expect, it } from 'vitest'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { resolveBareOrchestrationRecipient } from './orchestration/messaging/recipient-routing'

const HANDLE = 'term_slept'
const PANE_KEY = 'tab-1:leaf-1'

function routingFixture<T>(value: unknown): T {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recipient routing reads only the runtime and database lookup methods supplied by each fixture.
  return value as T
}

function runtimeWith(
  sleptPane: { paneKey: string; autoWakes: boolean } | null
): OrcaRuntimeService {
  return routingFixture({
    getLiveTerminalPaneKey: () => null,
    getResumableSleptRecipientPane: () => sleptPane
  })
}

function dbWith(overrides: Partial<OrchestrationDb> = {}): OrchestrationDb {
  return routingFixture({
    getCurrentRunForPane: () => undefined,
    getActiveDispatchMailboxOwners: () => [],
    getRunMailboxOwnerIdsForHandle: () => [],
    ...overrides
  })
}

describe('sending to a slept recipient', () => {
  it('routes to the run its slept coordinator pane owns', () => {
    const resolution = resolveBareOrchestrationRecipient({
      runtime: runtimeWith({ paneKey: PANE_KEY, autoWakes: true }),
      db: dbWith({
        getCurrentRunForPane: (paneKey: string) =>
          paneKey === PANE_KEY ? routingFixture({ id: 'run-1' }) : undefined
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
      db: dbWith({ getCurrentRunForPane: () => routingFixture({ id: 'run-1' }) }),
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
    const runtime = routingFixture<OrcaRuntimeService>({
      getLiveTerminalPaneKey: () => PANE_KEY,
      getResumableSleptRecipientPane: () => {
        throw new Error('must not consult sleeping records for a live pane')
      }
    })
    const resolution = resolveBareOrchestrationRecipient({
      runtime,
      db: dbWith({ getCurrentRunForPane: () => routingFixture({ id: 'run-1' }) }),
      handle: HANDLE
    })
    expect(resolution).toEqual({ ok: true, to: 'run:run-1', runId: 'run-1' })
  })

  it('tolerates a runtime that predates the slept-recipient lookup', () => {
    const runtime = routingFixture<OrcaRuntimeService>({ getLiveTerminalPaneKey: () => null })
    expect(
      resolveBareOrchestrationRecipient({ runtime, db: dbWith(), handle: HANDLE })
    ).toMatchObject({ ok: false, code: 'terminal_not_found' })
  })
})
