import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the startup half of the managed-hook first-run gate.
 *
 * Source-level for the same reason as pre-gone-crash-sampling-wiring.test.ts: the gate is a
 * composition inside the ready phase with no runtime seam, and the predicates it calls are unit
 * tested on their own. What cannot be unit tested is that the gate is still wired in here, and
 * that the codex real-home chain still hangs off the gated conjunction — that chain writes real
 * ~/.codex/hooks.json and runs an app-server trust grant, the most invasive first-run write.
 */
describe('managed hook first-run gate startup wiring', () => {
  // Why normalize: the anchors below are `\n`-prefixed and nothing pins src/**/*.ts to LF.
  const source = readFileSync(
    join(process.cwd(), 'src/main/startup/main-process-ready-runtime.ts'),
    'utf8'
  ).replace(/\r\n/g, '\n')

  const ENTRY = 'export async function initializeReadyRuntimeServices('
  const entryBody = source.slice(source.indexOf(ENTRY) + ENTRY.length).split('\nexport ')[0]

  it('gates the startup reconcile on the first-run predicate', () => {
    expect(source).toContain("from '../agent-hooks/managed-hook-first-run-gate'")
    expect(entryBody).toContain('isManagedHookInstallDeferredForFirstRun({')
    // Why pin the conjunct: without it the reconcile runs on a fresh profile before onboarding.
    expect(entryBody).toContain('\n    !deferManagedHooksForFirstRun &&')
  })

  it('never defers on a serve host, which never paints the wizard', () => {
    expect(entryBody).toContain('\n    !state.isServeMode &&')
  })

  it('retires the latch exactly once on any non-deferring launch', () => {
    expect(
      entryBody.split("store.updateSettings({ managedAgentHookFirstRunGate: 'done' })").length - 1
    ).toBe(1)
    expect(entryBody).toContain('isManagedHookFirstRunGatePending(startupManagedHookSettings)')
  })

  it('keeps the codex real-home chain behind the gated conjunction', () => {
    expect(entryBody).toContain(
      '  const realHomeCodexHookState =\n    shouldReconcileStartupManagedHooks &&'
    )
  })
})
