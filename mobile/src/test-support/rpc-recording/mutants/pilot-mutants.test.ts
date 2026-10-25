import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pilotGoldens } from '../derived-goldens'
import { readGolden } from '../golden-recording'
import { pilotMountAdapters } from '../pilot-mount-adapters'
import { runRecording, runRecordingMutant } from '../run-recording'
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
  'settings-home-providers-fulfilled': 'home-providers-linear',
  'settings-repo-metadata-fulfilled': 'repo-metadata-platform',
  'settings-task-hydration-fulfilled': 'task-hydration-envelope',
  'settings-task-write': 'task-preferences-optimistic',
  'settings-workspace-submit-fulfilled': 'workspace-submit-envelope',
  'settings-task-workspace-fulfilled': 'task-workspace-envelope',
  'native-chat-write-delivery-unknown': 'native-chat-send-delivery-unknown',
  'home-host-accounts': 'home-accounts-envelope',
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
// Pin archived defect states so unrelated reference refactors cannot pass merely by differing.
const referenceStates: Record<string, RecordedValue> = {
  b1: { files: [] },
  b2: {
    error: '',
    mutating: false,
    row: {
      content: {
        assignees: [],
        labels: [{ color: '808080', name: 'recorded' }],
        number: 1,
        repository: 'owner/repo'
      },
      id: 'item-1',
      itemType: 'ISSUE'
    }
  },
  b3: { error: 'issue refused', loading: false, payload: { $rpc: 'null' } }
}

function visibleState(recording: Recording): RecordedValue {
  return recording.checkpoints.at(-1)!.observation.state
}

const pilots = pilotGoldens(input.scenarios)
const mutantPilots = pilots.flatMap((pilot) => {
  const mutation = mutants[pilot.id]
  return mutation ? [{ ...pilot, mutation }] : []
})
const referencePilots = pilots.flatMap((pilot) => {
  const reference = referenceStates[pilot.id]
  return reference ? [{ ...pilot, reference }] : []
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
  for (const { id, scenario, reference } of referencePilots) {
    it.skipIf(!process.env.RPC_FOUNDATION_REFERENCE_ROOT)(`${id}: rejects bcba08b3e4`, async () => {
      const { adapters } = pilotMountAdapters(process.env.RPC_FOUNDATION_REFERENCE_ROOT!, {
        device: scenario,
        reference: true
      })
      const result = await runRecording(
        scenario,
        adapters[scenario.operation],
        vitestRecordingScheduler()
      )
      expect(visibleState(result)).toEqual(reference)
      expect(reference).not.toEqual(visibleState(readGolden(goldens, id).recording))
    })
  }
})
