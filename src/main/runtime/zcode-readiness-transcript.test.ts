import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import {
  getSyntheticAgentTerminalTitle,
  shouldDriveSyntheticAgentTitleFromHook
} from '../../shared/synthetic-agent-title'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'
import { hasExplicitIdleTitle } from './tui-idle-evidence'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function readTranscript(): string {
  return readFileSync(join(__dirname, '__fixtures__', 'zcode-composer-ready.txt'), 'utf8')
}

describe('ZCode readiness from captured terminal bytes', () => {
  it('never emits an OSC title, so no title lane can settle its wait', () => {
    const data = readTranscript()
    expect(data).toContain(String.fromCharCode(27))
    // Why: this absence is the whole reason ZCode needs a body-evidence readiness lane.
    expect(data).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\][0-2];`))
  })

  it('keeps repainting long after the composer mounts, so a quiet window never settles', () => {
    const data = readTranscript()
    const composerIndex = data.indexOf('╭')
    expect(composerIndex).toBeGreaterThan(-1)
    // Why: ~175KB of banner animation after the composer is up. A quiet-render window
    // measured in hundreds of ms cannot fire anywhere in that span.
    expect(data.length - composerIndex).toBeGreaterThan(100_000)
  })

  it('leaves no durable readiness evidence in the wait-text tail', async () => {
    const data = readTranscript()
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'zcode-first-class-workspace',
      foregroundProcess: 'zcode',
      launchAgent: 'zcode',
      data
    })
    // Why this asserts a NEGATIVE: Orca's wait text is a line-folded tail, and ZCode paints
    // its composer once and then repaints only the banner — so the composer scrolls out and
    // no screen rule can settle the wait. This is the evidence for driving ZCode readiness
    // from its synthetic hook title instead (see synthetic-agent-title.ts).
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).rejects.toThrow(/timeout/)
  }, 15_000)

  it('settles a tui-idle wait from the synthetic hook title Orca owns for ZCode', () => {
    expect(getSyntheticAgentTerminalTitle('zcode', 'done')).toBe('ZCode ready')
    expect(getSyntheticAgentTerminalTitle('zcode', 'waiting')).toBe('ZCode - action required')
    expect(shouldDriveSyntheticAgentTitleFromHook('zcode', 'working')).toBe(true)
    expect(
      hasExplicitIdleTitle({ lastAgentStatus: 'idle', lastOutputAt: Date.now() }, 'ZCode ready')
    ).toBe(true)
  })

  it('fires the draft-paste signal at the composer mount, not at the hard timeout', () => {
    const data = readTranscript()
    const scanner = createDraftPasteReadyScanner('zcode-composer-prompt')
    const composerIndex = data.indexOf('╭')
    // Why: feeding the stream in PTY-sized chunks proves the marker survives chunk splits.
    let readyAt: number | null = null
    for (let offset = 0; offset < data.length; offset += 4096) {
      const chunk = data.slice(offset, offset + 4096)
      if (scanner.observe(chunk).ready) {
        readyAt = offset + chunk.length
        break
      }
    }
    expect(readyAt).not.toBeNull()
    // Ready lands on the chunk that carries the composer corner, not thousands of frames later.
    expect(readyAt!).toBeGreaterThanOrEqual(composerIndex)
    expect(readyAt!).toBeLessThan(composerIndex + 8192)
  })
})
