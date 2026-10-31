import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pilotGoldens } from '../derived-goldens'
import { readGolden } from '../golden-recording'
import { pilotMountAdapters } from '../pilot-mount-adapters'
import { runRecordingMutant } from '../run-recording'
import { readScenarios } from '../scenario-input'
import { vitestRecordingScheduler } from '../vitest-recording-scheduler'
import { operationMutation, type Mutation } from './operation-mutations'
import type { Recording } from '../recording-scenario'
import type { RecordedValue } from '../recording-values'

const root = resolve(import.meta.dirname, '../../../../..')
const input = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
)
const goldens = process.env.RPC_FOUNDATION_GOLDENS ?? resolve(root, 'mobile/rpc-foundation/goldens')
// AI Vault history has no state mutant: changed rows also change the next asserted scopePaths and abort the scenario.
// Its non-crashing reply partitions project identical UI; coverage comes from subsequent scopePaths and the crash channel.
const mutants: Record<string, Mutation> = {
  b1: 'race',
  b2: 'acceptance',
  b3: 'order',
  'settings-bot-overrides-fulfilled': 'bot-overrides-envelope',
  'settings-workspace-context-fulfilled': 'workspace-context-envelope',
  'settings-repo-metadata-fulfilled': 'repo-metadata-platform',
  'settings-task-hydration-fulfilled': 'task-hydration-envelope',
  'settings-task-write': 'task-preferences-optimistic',
  'settings-workspace-submit-fulfilled': 'workspace-submit-envelope',
  'settings-task-workspace-fulfilled': 'task-workspace-envelope',
  'native-chat-write-delivery-unknown': 'native-chat-send-delivery-unknown',
  'notifications-display-test-accepted': 'push-test-envelope',
  'tasks-route-repo-list': 'task-screen-repo-envelope',
  'linear-select-workspace': 'linear-workspace-context-reload',
  'terminal-input-send-refused': 'terminal-send-refusal-restores-draft',
  'terminal-worktree-connection-resolved': 'worktree-connection-first-repo',
  'pr-sidebar-checks-refused': 'pr-sidebar-checks-failure-state',
  'tk-item-detail-metadata': 'assignable-user-avatar-null-collapse',
  'worktree-catalog-snapshot-unreadable': 'worktree-catalog-unchecked-reader',
  'mobile-web-bundle-fetch-paged': 'mobile-web-bundle-chunk-placement'
}
function visibleState(recording: Recording): RecordedValue {
  return recording.checkpoints.at(-1)!.observation.state
}

const pilots = pilotGoldens(input.scenarios)
const mutantPilots = pilots.flatMap((pilot) => {
  const mutation = mutants[pilot.id]
  return mutation ? [{ ...pilot, mutation }] : []
})
describe('RPC main recording mutants', () => {
  for (const { id, scenario, mutation } of mutantPilots) {
    it(`${id}: kills ${mutation}`, async () => {
      const { adapters, assertMutationApplied } = pilotMountAdapters(root, {
        device: scenario,
        mutation: operationMutation(mutation)
      })
      const result = await runRecordingMutant(
        scenario,
        adapters[scenario.operation],
        vitestRecordingScheduler(),
        readGolden(goldens, id).recording,
        visibleState
      )
      assertMutationApplied()
      expect(result.verdict).toBe('killed')
    })
  }
})
