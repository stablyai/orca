import { describe, expect, it } from 'vitest'
import { isKnownReadyPromptSettled } from './terminal-wait-detection'
import { shouldProbeVisibleScreen } from './terminal-wait'
import {
  visibleProbeNeedsRetry,
  visibleProbeReady,
  visibleProbeReadsScreen
} from './terminal-wait-visible-probe'

// Qoder 1.1.67's idle composer as `terminal read` shows it.
const QODER_IDLE_SCREEN = [
  'Qoder CLI v1.1.67',
  'Signed in Browser Login',
  '* Type your message or @path/to/file',
  'DeepSeek-Flash Model'
]

describe('tui-idle body probe', () => {
  it('probes a body-read agent whose live screen model cannot answer', () => {
    expect(
      shouldProbeVisibleScreen(
        'qoder',
        { lastAgentStatus: 'idle' },
        1,
        'Qoder CLI v1.1.67\nSigned in Browser Login',
        false
      )
    ).toBe(true)
  })

  it('keeps quiet while the live screen model can answer', () => {
    expect(
      shouldProbeVisibleScreen(
        'qoder',
        { lastAgentStatus: 'idle' },
        1,
        'Qoder CLI v1.1.67\nSigned in Browser Login',
        true
      )
    ).toBe(false)
  })

  it('does not add the probe for agents that settle without body evidence', () => {
    expect(shouldProbeVisibleScreen('amp', { lastAgentStatus: 'idle' }, 1, 'amp', false)).toBe(
      false
    )
  })

  it('settles Qoder from the provider screen composer', () => {
    expect(
      visibleProbeReady({
        agent: 'qoder',
        screenRule: false,
        snapshotText: QODER_IDLE_SCREEN.join('\n'),
        restoredLines: QODER_IDLE_SCREEN,
        hasOutputClock: true,
        working: false
      })
    ).toBe(true)
  })

  it('refuses a Qoder screen that still shows the trust menu', () => {
    const trustScreen = ['Do you trust the files in this folder?', "Don't trust and exit"]
    expect(
      visibleProbeReady({
        agent: 'qoder',
        screenRule: false,
        snapshotText: trustScreen.join('\n'),
        restoredLines: trustScreen,
        hasOutputClock: true,
        working: false
      })
    ).toBe(false)
  })

  it('keeps a working Qoder turn from settling on its composer', () => {
    expect(
      visibleProbeReady({
        agent: 'qoder',
        screenRule: false,
        snapshotText: QODER_IDLE_SCREEN.join('\n'),
        restoredLines: QODER_IDLE_SCREEN,
        hasOutputClock: true,
        working: true
      })
    ).toBe(false)
  })

  it('reads a real screen for body-read agents', () => {
    expect(visibleProbeReadsScreen('qoder', false)).toBe(true)
    expect(visibleProbeReadsScreen('qoder-cn', false)).toBe(true)
    expect(visibleProbeReadsScreen('amp', false)).toBe(false)
    expect(visibleProbeReadsScreen('claude', true)).toBe(true)
  })

  it('retries only while a body-read agent is working and time remains', () => {
    expect(visibleProbeNeedsRetry('qoder', true, 5_000)).toBe(true)
    expect(visibleProbeNeedsRetry('qoder', true, 1_000)).toBe(false)
    expect(visibleProbeNeedsRetry('qoder', false, 5_000)).toBe(false)
    expect(visibleProbeNeedsRetry('amp', true, 5_000)).toBe(false)
  })

  it('keeps the settled-preview rule for agents without body rules', () => {
    const text = '› Ask Codex to do anything'
    expect(
      visibleProbeReady({
        agent: 'codex',
        screenRule: false,
        snapshotText: text,
        restoredLines: [text],
        hasOutputClock: true,
        working: false
      })
    ).toBe(isKnownReadyPromptSettled(text))
  })
})
