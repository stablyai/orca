import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readScenarios } from '../scenario-input'
import { readGolden } from '../golden-recording'
import { runRecordingMutant } from '../run-recording'
import { pilotMountAdapters } from '../pilot-mount-adapters'
import { vitestRecordingScheduler } from '../vitest-recording-scheduler'
import { operationMutation, type Mutation } from './operation-mutations'

const root = resolve(import.meta.dirname, '../../../../..')
const input = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
)
const goldens = process.env.RPC_FOUNDATION_GOLDENS ?? resolve(root, 'mobile/rpc-foundation/goldens')

/**
 * Each probe exists because a real mutation survived the whole pre-probe suite. Hole and closure
 * are asserted together: if a pre-probe scenario of the same operation also caught the mutation,
 * the probe is redundant and this test says so instead of letting it accumulate.
 *
 * The three session entries are the same shape one step later: each names a guard whose false arm
 * no session recording reached, because every scenario of its family declared the cell filled. The
 * closing scenario declares it empty, so the member the guard drops is absent from the wire and the
 * mutant that always sends it has somewhere to diverge.
 */
const HOLES: readonly { mutation: Mutation; operation: string; closedBy: readonly string[] }[] = [
  {
    mutation: 'new-tab-refusal-order',
    operation: 'settings.new-tab-agents',
    closedBy: ['probe-new-tab-both-refused']
  },
  {
    mutation: 'new-tab-deferred-settings-read',
    operation: 'settings.new-tab-agents',
    closedBy: ['probe-new-tab-null-sibling-refused']
  },
  {
    mutation: 'workspace-context-refusal-blanks',
    operation: 'settings.workspace-context',
    closedBy: ['settings-workspace-context-refuse-after-data']
  },
  {
    mutation: 'display-mode-unconditional-client',
    operation: 'session.terminal-display-mode',
    closedBy: ['session-terminal-display-mode-auto-without-device-token']
  },
  {
    mutation: 'display-mode-unmeasured-viewport',
    operation: 'session.terminal-display-mode',
    closedBy: ['session-terminal-display-mode-auto-without-viewport']
  },
  {
    mutation: 'startup-tab-load-rejects-sequence',
    operation: 'session.startup',
    closedBy: ['session-startup-refused-tab-load-still-loads-terminals']
  }
]

/** What the scripted transport raises when a send no longer carries the params the step asserts. */
const PARAMS_MISMATCH = 'Request params mismatch:'

/**
 * A mutation that changes a param the scenario completes is caught before a recording exists to
 * compare: the transport asserts the sender's params at every `complete`, so the sequence aborts
 * where a state or effect mutation would have diverged. The scenario detected it, which is what
 * `killed` means here — narrowed to that one message, and only once the anchor is proved applied,
 * so a mutant that failed to apply or a scenario that broke some other way still fails loudly.
 */
async function verdict(id: string, mutation: Mutation): Promise<string> {
  const scenario = input.scenarios.find((candidate) => candidate.id === id)!
  const { adapters, assertMutationApplied } = pilotMountAdapters(root, {
    device: scenario,
    mutation: operationMutation(mutation)
  })
  try {
    const result = await runRecordingMutant(
      scenario,
      adapters[scenario.operation],
      vitestRecordingScheduler(),
      readGolden(goldens, id).recording
    )
    assertMutationApplied()
    return result.verdict
  } catch (error) {
    assertMutationApplied()
    if (error instanceof Error && error.message.startsWith(PARAMS_MISMATCH)) {
      return 'killed'
    }
    throw error
  }
}

describe('probe scenarios close holes the pre-probe recordings left open', () => {
  for (const hole of HOLES) {
    const family = input.scenarios.filter((scenario) => scenario.operation === hole.operation)
    for (const id of hole.closedBy) {
      it(`${id} kills ${hole.mutation}`, async () => {
        expect(await verdict(id, hole.mutation)).toBe('killed')
      })
    }
    for (const scenario of family.filter(({ id }) => !hole.closedBy.includes(id))) {
      it(`${scenario.id} cannot see ${hole.mutation}`, async () => {
        expect(await verdict(scenario.id, hole.mutation)).toBe('survived')
      })
    }
  }
})
