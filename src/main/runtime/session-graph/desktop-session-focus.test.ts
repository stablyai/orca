import { describe, expect, it } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { surfaceRuntime } from '../terminal/surface/terminal-surface-replies.test-fixture'

const WORKSPACE = 'folder:project-work'
describe('desktop session focus publication', () => {
  it('uses only the current authoritative renderer publication, including metadata-only chat changes', async () => {
    const { runtime } = surfaceRuntime()
    expect(runtime.readActiveSessionId(WORKSPACE)).toBeUndefined()
    const seen: (string | null | undefined)[] = []
    const stop = runtime.onActiveSessionChanged(() => {
      seen.push(runtime.readActiveSessionId(WORKSPACE))
    })
    const graph = { tabs: [], leaves: [], rendererGeneration: 'renderer:focus-one' }
    await runtime.syncWindowGraph(1, {
      ...graph,
      activeSessionIdsByWorkspace: { [WORKSPACE]: 'codex_A' }
    })
    await runtime.syncWindowGraph(1, {
      ...graph,
      activeSessionIdsByWorkspace: { [WORKSPACE]: 'codex_A' }
    })
    await runtime.syncWindowGraph(1, {
      ...graph,
      activeSessionIdsByWorkspace: { [WORKSPACE]: 'claude_B' }
    })
    await runtime.syncWindowGraph(1, {
      ...graph,
      activeSessionIdsByWorkspace: { [WORKSPACE]: null }
    })
    await runtime.syncWindowGraph(1, { ...graph, rendererGeneration: 'renderer:focus-two' })
    expect(seen).toEqual(['codex_A', 'claude_B', null, undefined])
    expect(runtime.readActiveSessionId(WORKSPACE)).toBeUndefined()
    await expect(
      runtime.syncWindowGraph(2, {
        ...graph,
        activeSessionIdsByWorkspace: { [WORKSPACE]: 'wrong_window' }
      })
    ).rejects.toThrow()
    expect(runtime.readActiveSessionId(WORKSPACE)).toBeUndefined()
    stop()
  })

  it('notifies subscribers when focus becomes unavailable and when a cancelled reload restores it', async () => {
    const { runtime } = surfaceRuntime()
    const seen: (string | null | undefined)[] = []
    const stop = runtime.onActiveSessionChanged(() => {
      seen.push(runtime.readActiveSessionId(WORKSPACE))
    })
    await runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      rendererGeneration: 'renderer:before-loss',
      activeSessionIdsByWorkspace: { [WORKSPACE]: 'codex_A' }
    })
    const fence = runtime.markRendererReloading(1)
    expect(fence).not.toBeNull()
    expect(runtime.markRendererReloadCancelled(1, fence!)).toBe(true)
    runtime.markGraphReloadFailed(1, 'renderer-process-gone')
    await runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      rendererGeneration: 'renderer:after-loss',
      activeSessionIdsByWorkspace: { [WORKSPACE]: 'claude_B' }
    })
    runtime.markGraphUnavailable(2)
    runtime.markGraphUnavailable(1)
    expect(seen).toEqual(['codex_A', undefined, 'codex_A', undefined, 'claude_B', undefined])
    stop()
  })

  it('does not expose headless focus intentions or malformed identities as desktop selection', async () => {
    const { runtime } = surfaceRuntime()
    await runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, {
      tabs: [],
      leaves: [],
      rendererGeneration: 'renderer:pretend',
      activeSessionIdsByWorkspace: { [WORKSPACE]: 'codex_A' }
    })
    expect(runtime.readActiveSessionId(WORKSPACE)).toBeUndefined()
    const { runtime: desktop } = surfaceRuntime()
    await desktop.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      rendererGeneration: 'renderer:desktop',
      activeSessionIdsByWorkspace: { [WORKSPACE]: '/provider/file' }
    })
    expect(desktop.readActiveSessionId(WORKSPACE)).toBeUndefined()
  })
})
