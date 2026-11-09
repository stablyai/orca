import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pilotMountAdapters } from './pilot-mount-adapters'
import { runRecording } from './run-recording'
import { readScenarios } from './scenario-input'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'

const root = resolve(import.meta.dirname, '../../../..')
const manifest = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
).scenarios

describe('a mounted screen', () => {
  // Drive the real panel/context/socket so declared props reach wire params and refusal triggers fallback.
  it('sends what the screen sends, with no substitute shaping a param', async () => {
    const scenario = manifest.find(
      (candidate) => candidate.id === 'files-explorer-legacy-fallback'
    )!
    const { adapters } = pilotMountAdapters(root, { device: scenario })
    const recording = await runRecording(
      scenario,
      adapters[scenario.operation]!,
      vitestRecordingScheduler()
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a recorded sender entry has a name and three positional argument slots.
    const sender = recording.checkpoints.at(-1)!.observation.sender as {
      name: string
      args: { name: string; value: unknown }[]
    }[]
    expect(
      sender.map((entry) => ({
        name: entry.name,
        params: entry.args[1]?.value,
        options: entry.args[2]?.value
      }))
    ).toEqual([
      {
        name: 'files.readDir#1',
        params: { relativePath: '', worktree: 'id:wt-files', limit: 500 },
        options: { failWhenDisconnected: true }
      },
      {
        name: 'files.list#1',
        params: { worktree: 'id:wt-files' },
        options: { failWhenDisconnected: true }
      }
    ])
  })
})
