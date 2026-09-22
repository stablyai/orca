import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'
import { TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import {
  getSyntheticAgentTerminalTitle,
  shouldDriveSyntheticAgentTitleFromHook
} from '../../shared/synthetic-agent-title'
import { detectAgentStatusFromTitle, getAgentLabel } from '../../shared/agent-detection'
import { isKnownReadyPromptPreview } from './terminal-wait-detection'

const ready = readFileSync(new URL('./__fixtures__/prime-ready.txt', import.meta.url), 'utf8')
const turn = readFileSync(new URL('./__fixtures__/prime-turn.txt', import.meta.url), 'utf8')

const modernReady = readFileSync(
  new URL('./__fixtures__/prime-095-ready.txt', import.meta.url),
  'utf8'
)
const modernTurn = readFileSync(
  new URL('./__fixtures__/prime-095-turn.txt', import.meta.url),
  'utf8'
)

describe('Prime readiness', () => {
  it('accepts the captured 0.9.5 idle screen and rejects its busy transcript', async () => {
    for (const [data, expected] of [
      [modernReady, true],
      [modernTurn, false]
    ] as const) {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'prime-agent',
        foregroundProcess: 'prime-agent',
        data
      })
      const snapshot = await runtime.readTerminal(handle)
      expect(
        isKnownReadyPromptPreview(snapshot.tail.join('\n')),
        JSON.stringify(snapshot.tail)
      ).toBe(expected)
    }
  })
  it('does not accept a modern footer while a spinner is above it', () => {
    expect(
      isKnownReadyPromptPreview(
        'prime agent v0.9.5\n⠋ Waiting\n >\n← manage deepseek-v4.1-flash · 0 (0%)'
      )
    ).toBe(false)
  })

  it('accepts a captured cold-start prompt through the runtime', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'prime-agent',
      foregroundProcess: 'prime-agent',
      data: ready
    })
    Reflect.defineProperty(runtime, 'getPaneAgentForTuiIdle', { value: () => 'prime-agent' })
    const snapshot = await runtime.readTerminal(handle)
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue(snapshot)
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
    ).resolves.toMatchObject({ condition: 'tui-idle' })
  })

  it('rechecks a Prime screen that was not ready on its first read', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'prime-agent',
      foregroundProcess: 'prime-agent',
      data: ready
    })
    Reflect.defineProperty(runtime, 'getPaneAgentForTuiIdle', { value: () => 'prime-agent' })
    const snapshot = await runtime.readTerminal(handle)
    const read = vi
      .spyOn(runtime, 'readTerminal')
      .mockResolvedValueOnce({ ...snapshot, tail: ['Starting Prime'] })
      .mockResolvedValue(snapshot)
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1500 })
    ).resolves.toMatchObject({ condition: 'tui-idle' })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a startup footer after a turn begins, then accepts hook completion', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'prime-agent',
      foregroundProcess: 'prime-agent',
      data: turn
    })
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 30 })
    ).rejects.toThrow()
    const title = getSyntheticAgentTerminalTitle('prime-agent', 'done')
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, `\x1b]0;${title}\x07`, Date.now())
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
    ).resolves.toMatchObject({ condition: 'tui-idle' })
  })

  it.each([
    ['done', 'idle'],
    ['blocked', 'permission'],
    ['waiting', 'permission']
  ] as const)(
    'classifies the hook-driven %s title without losing Prime identity',
    (state, status) => {
      const title = getSyntheticAgentTerminalTitle('prime-agent', state)!
      expect(shouldDriveSyntheticAgentTitleFromHook('prime-agent', state)).toBe(true)
      expect(detectAgentStatusFromTitle(title)).toBe(status)
      expect(getAgentLabel(title)).toBe('Prime Agent')
    }
  )

  it('keeps the working spinner attached to Prime', () => {
    expect(shouldDriveSyntheticAgentTitleFromHook('prime-agent', 'working')).toBe(true)
    expect(detectAgentStatusFromTitle('⠋ Prime Agent')).toBe('working')
    expect(getAgentLabel('⠋ Prime Agent')).toBe('Prime Agent')
  })

  it('rejects an unresolved model and a later working spinner', () => {
    expect(isKnownReadyPromptPreview('model model-id\n← agents/resume — ? for shortcuts')).toBe(
      false
    )
    expect(
      isKnownReadyPromptPreview('model model-id\n← agents/resume model ? for shortcuts\n⠋ Waiting')
    ).toBe(false)
  })
})
