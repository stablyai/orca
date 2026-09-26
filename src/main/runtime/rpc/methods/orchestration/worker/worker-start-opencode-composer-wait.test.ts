import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import { resolveDraftPasteReadyTimeoutMs } from '../../../../../../shared/draft-paste-ready-timeout'

const OPENCODE_DEFAULT_COMPOSER_TIMEOUT_MS = resolveDraftPasteReadyTimeoutMs('opencode')

// tui-idle fires on the generic OSC-title idle edge. opencode (and mimo-code, which shares its
// config) enable bracketed paste before their composer actually mounts, so tui-idle can resolve
// on their boot splash: worker-start then pastes the dispatch preamble into a screen with no
// composer to catch it, and the preamble is silently dropped even though the receipt reports
// `input_accepted` / `ready`. This asserts worker-start waits for opencode's own composer-mount
// marker (`waitForAgentComposerReady`, reusing the existing render-cursor-after-bracketed-paste
// detector) before writing the preamble, and that unrelated agents are unaffected.
describe('worker-start composer readiness for opencode', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => harness.setup())
  afterEach(() => harness.cleanup())

  it('waits for the opencode composer marker before delivering the preamble', async () => {
    const composerWait = vi
      .spyOn(harness.runtime, 'waitForAgentComposerReady')
      .mockResolvedValue(true)
    const sends: string[] = []
    vi.spyOn(harness.runtime, 'sendTerminalAgentPrompt').mockImplementation(async () => {
      sends.push('sendTerminalAgentPrompt')
      return { handle: 'term_worker', accepted: true, bytesWritten: 1 }
    })
    composerWait.mockImplementation(async () => {
      sends.push('waitForAgentComposerReady')
      return true
    })

    const task = harness.db.createTask({
      spec: 'opencode composer fixture',
      runId: harness.activeRunId
    })
    const result = (await harness.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'opencode'
    })) as { state: string }

    expect(result.state).toBe('ready')
    expect(composerWait).toHaveBeenCalledWith(
      'term_worker',
      'opencode',
      OPENCODE_DEFAULT_COMPOSER_TIMEOUT_MS
    )
    expect(sends).toEqual(['waitForAgentComposerReady', 'sendTerminalAgentPrompt'])
  })

  it('caps the composer wait at an explicit --timeout-ms shorter than the default', async () => {
    const composerWait = vi
      .spyOn(harness.runtime, 'waitForAgentComposerReady')
      .mockResolvedValue(true)

    const task = harness.db.createTask({
      spec: 'opencode short timeout fixture',
      runId: harness.activeRunId
    })
    await harness.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'opencode',
      timeoutMs: 2_000
    })

    expect(composerWait).toHaveBeenCalledWith('term_worker', 'opencode', 2_000)
  })

  it('proceeds anyway when the opencode composer marker times out', async () => {
    vi.spyOn(harness.runtime, 'waitForAgentComposerReady').mockResolvedValue(false)

    const task = harness.db.createTask({
      spec: 'opencode timeout fixture',
      runId: harness.activeRunId
    })
    const result = (await harness.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'opencode'
    })) as { state: string }

    expect(result.state).toBe('ready')
  })

  it('does not gate an unrelated agent (codex) on the opencode composer marker', async () => {
    const composerWait = vi
      .spyOn(harness.runtime, 'waitForAgentComposerReady')
      .mockResolvedValue(true)

    const task = harness.db.createTask({ spec: 'codex fixture', runId: harness.activeRunId })
    const result = (await harness.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })) as { state: string }

    expect(result.state).toBe('ready')
    expect(composerWait).not.toHaveBeenCalled()
  })

  it('does not gate a reused --terminal (no --agent, e.g. a pre-warmed handle)', async () => {
    const composerWait = vi
      .spyOn(harness.runtime, 'waitForAgentComposerReady')
      .mockResolvedValue(true)

    await harness.startWorker({ terminal: 'term_worker' })

    expect(composerWait).not.toHaveBeenCalled()
  })
})
