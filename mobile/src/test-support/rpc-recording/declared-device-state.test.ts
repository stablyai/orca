import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { declaredDeviceSubstitutes } from './declared-device-state'
import { nativeMountingSubstitutes } from './native-mounting-substitutes'
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

const STORE = '@react-native-async-storage/async-storage'

function store(declared: Record<string, string>): {
  module: Record<string, (...args: unknown[]) => Promise<unknown>>
  effects: { name: string; value: unknown }[]
} {
  const effects: { name: string; value: unknown }[] = []
  const device = declaredDeviceSubstitutes({ deviceStore: declared })
  device.bind((name, value) => effects.push({ name, value }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the declared store answers every member; the test asserts what each one does.
  const module = device.substitutes.get(STORE) as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >
  return { module, effects }
}

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
  it('leaves the refusing store in place when nothing is declared', () => {
    const undeclared = declaredDeviceSubstitutes({})
    expect(undeclared.substitutes.size).toBe(0)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the table's default store answers every member with a throwing call.
    const fallback = nativeMountingSubstitutes().get(STORE) as { getItem: () => unknown }
    expect(() => fallback.getItem()).toThrow('Native store reached during recording')
  })

  it('reads the declared entry, and null for everything else', async () => {
    const { module } = store({ 'orca:key': 'declared' })
    await expect(module.getItem!('orca:key')).resolves.toBe('declared')
    await expect(module.getItem!('orca:other')).resolves.toBeNull()
  })

  /**
   * A write that fed back into a read would let a later read return a byte nothing declared, which
   * is the device back inside the recording. The write is an effect instead, where it is observed.
   */
  it('records a write as an effect without letting a read see it', async () => {
    const { module, effects } = store({})
    await module.setItem!('orca:key', 'written')
    await module.removeItem!('orca:key')
    await expect(module.getItem!('orca:key')).resolves.toBeNull()
    expect(effects).toEqual([
      { name: 'device-store.setItem', value: { key: 'orca:key', value: 'written' } },
      { name: 'device-store.removeItem', value: { key: 'orca:key' } }
    ])
  })

  it('refuses a member the declaration does not back', () => {
    const { module } = store({})
    expect(() => module.multiGet!('orca:key')).toThrow(
      `Native store reached during recording: ${STORE}.multiGet`
    )
  })

  it('answers a declared tray, and records a dismissal as an effect', async () => {
    const entry = { request: { identifier: 'tray-1', content: { data: { a: 1 } } } }
    const effects: { name: string; value: unknown }[] = []
    const device = declaredDeviceSubstitutes({ deviceState: { notificationTray: [entry] } })
    device.bind((name, value) => effects.push({ name, value }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the declared tray lists exactly these two members.
    const module = device.substitutes.get('expo-notifications') as {
      getPresentedNotificationsAsync: () => Promise<unknown[]>
      dismissNotificationAsync: (identifier: string) => Promise<void>
    }
    const presented = await module.getPresentedNotificationsAsync()
    expect(presented).toEqual([entry])
    expect(presented[0]).not.toBe(entry)
    await module.dismissNotificationAsync('tray-1')
    expect(effects).toEqual([
      { name: 'notification-tray.dismiss', value: { identifier: 'tray-1' } }
    ])
  })

  it('backs a recorded read: the declared last-visited repo is the one the dialog selects', async () => {
    const recording = await record('new-workspace-repositories-fulfilled')
    expect(sentParams(recording)).toEqual({ name: 'repo.list#1', params: { $rpc: 'absent' } })
    // repo-a is the first eligible repo, so repo-b can only come from the declared entry.
    expect(lastCheckpoint(recording).state).toMatchObject({ selected: 'repo-b' })
  })

  it('backs a recorded write: the reset credit journals its key before the request', async () => {
    const recording = await record('codex-reset-credit-consumed')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a recorded request's params are recorded data.
    const params = sentParams(recording) as { name: string; params: { idempotencyKey?: string } }
    expect(params.name).toBe('accounts.consumeCodexResetCredit#1')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recorded effects are a list of name/value pairs.
    const effects = lastCheckpoint(recording).effects as { name: string; value: unknown }[]
    expect(effects.map((effect) => effect.name)).toEqual(['device-store.setItem'])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    const write = effects[0]!.value as { key: string; value: string }
    expect(write.key).toMatch(/^orca:codex-reset-credit-attempt:v1:[0-9a-f]{64}$/)
    expect(JSON.parse(write.value)).toMatchObject({ idempotencyKey: params.params.idempotencyKey })
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
