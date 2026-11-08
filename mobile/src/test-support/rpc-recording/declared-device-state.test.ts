import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pilotMountAdapters } from './pilot-mount-adapters'
import { runRecording } from './run-recording'
import { readScenarios } from './scenario-input'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'
import type { Recording, RecordingScenario } from './recording-scenario'
import type { RecordedValue } from './recording-values'

const root = resolve(import.meta.dirname, '../../../..')
const manifest = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
).scenarios

function scenario(id: string): RecordingScenario {
  const found = manifest.find((candidate) => candidate.id === id)
  if (!found) {
    throw new Error(`No scenario named ${id}`)
  }
  return found
}

async function record(id: string): Promise<Recording> {
  const declared = scenario(id)
  const { adapters } = pilotMountAdapters(root, { device: declared })
  return runRecording(declared, adapters[declared.operation]!, vitestRecordingScheduler())
}

function lastCheckpoint(recording: Recording): {
  sender: RecordedValue
  effects: RecordedValue
  state: RecordedValue
} {
  const { observation } = recording.checkpoints.at(-1)!
  return { sender: observation.sender, effects: observation.effects, state: observation.state }
}

function sentParams(recording: Recording, index = 0): unknown {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a recorded sender entry has three positional argument slots.
  const sender = lastCheckpoint(recording).sender as {
    name: string
    args: { name: string; value: unknown }[]
  }[]
  return { name: sender[index]?.name, params: sender[index]?.args[1]?.value }
}

describe('a scenario that declares its device', () => {
  it('backs a recorded read: the declared last-visited repo is the one the dialog selects', async () => {
    const recording = await record('new-workspace-repositories-fulfilled')
    expect(sentParams(recording)).toEqual({ name: 'repo.list#1', params: { $rpc: 'absent' } })
    // repo-a is the first eligible repo, so repo-b can only come from the declared entry.
    expect(lastCheckpoint(recording).state).toMatchObject({ selected: 'repo-b' })
  })

  it('records no device write for the reset credit: the host ledger keeps the attempt', async () => {
    const recording = await record('codex-reset-credit-consumed')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a recorded request's params are recorded data.
    const params = sentParams(recording) as { name: string; params: { idempotencyKey?: string } }
    expect(params.name).toBe('accounts.consumeCodexResetCredit#1')
    expect(params.params.idempotencyKey).toEqual(expect.any(String))
    expect(lastCheckpoint(recording).effects).toEqual([])
  })

  it('backs a recorded tray: the presented push is the identity the catch-up sends', async () => {
    const recording = await record('push-dismissal-tray-reconciled')
    expect(sentParams(recording)).toEqual({
      name: 'notifications.getMissedSince#1',
      params: {
        lastSeenSeq: Number.MAX_SAFE_INTEGER,
        deliveredPushes: [
          { notificationEpoch: 'epoch-1', notificationId: 'note-1', notificationSeq: 7 }
        ]
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recorded effects are a list of name/value pairs.
    const effects = lastCheckpoint(recording).effects as { name: string }[]
    expect(effects.map((effect) => effect.name)).toEqual([
      'device-store.setItem',
      'notification-tray.dismiss'
    ])
  })
})
