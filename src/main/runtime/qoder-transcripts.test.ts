import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, waitForTranscriptIdle } from './agent-transcript-pane-test-harness'
import { extractLastOscTitle } from '../../shared/osc-title-extraction'
import { getAgentLabel, normalizeTerminalTitle } from '../../shared/agent-detection'
import { RuntimeMachineName } from './runtime-machine-name'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

let machineNameStartSpy: { mockRestore(): void } | undefined

beforeEach(() => {
  machineNameStartSpy = vi.spyOn(RuntimeMachineName.prototype, 'start').mockImplementation(() => {})
})

afterEach(() => {
  machineNameStartSpy?.mockRestore()
  machineNameStartSpy = undefined
})

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
        await runtime.readTerminal(handle, { screen: true })
        const readiness = await waitForTranscriptIdle({ runtime, handle }, 600).catch(() => null)
        expect(readiness?.satisfied ?? false).toBe(false)
      }
      if (fixture === 'qoder-ready') {
        await runtime.readTerminal(handle, { screen: true })
        const readiness = await waitForTranscriptIdle({ runtime, handle }, 1500)
        expect(readiness.satisfied).toBe(true)
      }
    }
  )
})

describe('captured Qoder China 1.1.65 startup', () => {
  it.each(['qoder-cn-startup', 'qoder-cn-signin'])('checks the composer in %s', async (fixture) => {
    const data = readFileSync(join(__dirname, '__fixtures__', `${fixture}.txt`), 'utf8')
    const title = extractLastOscTitle(
      data.replaceAll(`${String.fromCharCode(27)}]0;${String.fromCharCode(7)}`, '')
    )
    expect(getAgentLabel(normalizeTerminalTitle(title ?? ''))).toBe('Qoder CLI CN')
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: title ?? '',
      foregroundProcess: 'qoderclicn',
      launchAgent: 'qoder-cn',
      data,
      size: { cols: 120, rows: 40 }
    })
    expect((await runtime.showTerminal(handle)).agentIdentity).toBe('qoder-cn')
    await runtime.readTerminal(handle, { screen: true })
    const readiness = await waitForTranscriptIdle({ runtime, handle }, 800).catch(() => null)
    expect(readiness?.satisfied ?? false).toBe(false)
  })
})
