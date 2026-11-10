import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from '../../../../shared/draft-paste-ready-scanner'
import { readRuntimeFixture, replayTranscript } from './agent-transcript-replay-test-harness'

describe('Codex launch draft readiness from captured PTY output', () => {
  it.each([
    'codex-fullscreen-startup',
    'codex-fullscreen-early-input',
    'codex-fullscreen-multiline-early-input',
    'codex-fullscreen-custom-footer'
  ])('%s: waits through the provisional composer and resolves on the live footer', async (name) => {
    const data = readRuntimeFixture(name)
    const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
    let sawProvisionalComposer = false
    let sawReady = false
    let offset = 0
    for await (const frame of replayTranscript(data, 120, 40)) {
      const result = scanner.observe(data.slice(offset, offset + 64))
      offset += 64
      const hasFooter = frame.screenLines.some((line) => line.includes('GPT-6.1-Sol'))
      const hasComposer = frame.screenLines.some((line) => line.trimStart().startsWith('›'))
      if (hasComposer && !hasFooter) {
        sawProvisionalComposer = true
        expect(result.ready).toBe(false)
      }
      if (result.ready) {
        expect(hasFooter).toBe(true)
        sawReady = true
      }
    }
    expect(sawProvisionalComposer).toBe(true)
    expect(sawReady).toBe(true)
  })
})
