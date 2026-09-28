import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'
import { extractLastOscTitle } from '../../shared/osc-title-extraction'
import { getAgentLabel, normalizeTerminalTitle } from '../../shared/agent-detection'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('captured Qoder 1.1.64 startup', () => {
  it.each(['qoder-trust-dialog', 'qoder-no-account', 'qoder-ready'])(
    'preserves Qoder identity in %s',
    async (fixture) => {
      const data = readFileSync(join(__dirname, '__fixtures__', `${fixture}.txt`), 'utf8')
      // The recorder's shutdown clears the OSC title; inspect the live capture before that reset.
      const title = extractLastOscTitle(
        data.replaceAll(`${String.fromCharCode(27)}]0;${String.fromCharCode(7)}`, '')
      )
      expect(title).toContain(' | Ready')
      expect(getAgentLabel(normalizeTerminalTitle(title ?? ''))).toBe('Qoder CLI')
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: title ?? '',
        foregroundProcess: 'qodercli-1.1.64',
        launchAgent: 'qoder',
        data,
        size: { cols: 100, rows: 32 }
      })
      const shown = await runtime.showTerminal(handle)
      expect(shown.agentIdentity).toBe('qoder')
      if (fixture === 'qoder-trust-dialog') {
        const readiness = await runtime
          .waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 600 })
          .catch(() => null)
        expect(readiness?.satisfied ?? false).toBe(false)
      }
      if (fixture === 'qoder-ready') {
        const readiness = await runtime.waitForTerminal(handle, {
          condition: 'tui-idle',
          timeoutMs: 1500
        })
        expect(readiness.satisfied).toBe(true)
      }
    }
  )
})
