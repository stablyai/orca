import { resolve } from 'node:path'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { hookScreenMount, projectMountedScreen, screenMount } from './mounted-screen-tree'
import { pilotMountAdapters } from './pilot-mount-adapters'
import { runRecording } from './run-recording'
import { readScenarios } from './scenario-input'
import { vitestRecordingScheduler } from './vitest-recording-scheduler'

const root = resolve(import.meta.dirname, '../../../..')
const manifest = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
).scenarios

function Broken(): never {
  throw new Error('a reply took the screen down')
}

function effectSink(): {
  calls: { name: string; value: unknown }[]
  effect: (name: string, value: unknown) => void
} {
  const calls: { name: string; value: unknown }[] = []
  return { calls, effect: (name, value) => calls.push({ name, value }) }
}

describe('a mounted screen', () => {
  it('records a crash as state instead of failing the run', () => {
    const screen = screenMount(() => createElement(Broken), effectSink().effect)
    screen.mount()
    expect(projectMountedScreen(screen)).toEqual({
      elements: {},
      text: [],
      labels: [],
      crash: 'a reply took the screen down'
    })
  })

  // Hook projections omit crashes; the effect sink must record them independently.
  it('reports a crash through the effect sink with no adapter cooperation', () => {
    const sink = effectSink()
    let renders = 0
    const screen = hookScreenMount(() => {
      renders++
      // Keep throwing on retries too; React’s synchronous retry would otherwise recover before the boundary.
      if (renders >= 2) {
        throw new Error('the second render threw')
      }
    }, sink.effect)
    screen.mount()
    expect(sink.calls).toEqual([])
    screen.update()
    expect(sink.calls).toEqual([
      { name: 'screen.crash', value: { message: 'the second render threw' } }
    ])
  })

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
        params: { relativePath: '', worktree: 'id:wt-files' },
        options: { $rpc: 'absent' }
      },
      {
        name: 'files.list#1',
        params: { worktree: 'id:wt-files' },
        options: { $rpc: 'absent' }
      }
    ])
  })
})
