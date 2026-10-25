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

// Prove each probe closes a surviving mutation and that earlier scenarios stayed blind.
// Empty session inputs exercise omission guards that always-filled fixtures could not reach.
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
  },
  {
    mutation: 'create-after-tab-id-null',
    operation: 'session.create-terminal',
    closedBy: ['session-create-terminal-without-active-tab']
  },
  {
    mutation: 'create-quick-command-keys',
    operation: 'session.create-terminal',
    closedBy: [
      'session-create-terminal-runs-a-quick-command',
      'session-create-terminal-launches-an-agent-quick-command'
    ]
  },
  {
    mutation: 'create-second-tap-in-flight',
    operation: 'session.create-terminal',
    closedBy: ['session-create-terminal-ignores-a-second-create-in-flight']
  }
]

/** What the scripted transport raises when a send no longer carries the params the step asserts. */
const PARAMS_MISMATCH = 'Request params mismatch:'

// Count only params-mismatch aborts after proving the anchor applied; unrelated scenario/loader failures must stay loud.
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
  // Every completion needs a later checkpoint so a params-mismatch abort always suppresses an observation the golden actually holds.
  it('never completes a request after the last checkpoint of a scenario', () => {
    const trailing = input.scenarios
      .filter((scenario) => {
        let lastComplete = -1
        let lastCheckpoint = -1
        scenario.steps.forEach((step, index) => {
          if ('complete' in step) {
            lastComplete = index
          }
          // A step may carry both, and then the checkpoint records what the completion produced.
          if ('checkpoint' in step) {
            lastCheckpoint = index
          }
        })
        return lastComplete > lastCheckpoint
      })
      .map((scenario) => scenario.id)
    expect(trailing).toEqual([])
  })

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
