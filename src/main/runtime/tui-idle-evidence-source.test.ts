import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import { ptyTuiIdleEvidence, type TuiIdleEvidenceSource } from './tui-idle-evidence-source'
import { makeTuiIdlePty } from './tui-idle-wait-test-harness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function source(agent: TuiAgent): TuiIdleEvidenceSource {
  return {
    quiescenceMs: 3000,
    getTabTitle: () => null,
    getAdoptedPtyIdleStatus: () => 'idle',
    getPaneAgent: () => agent,
    getFirstPartyAgentStatus: () => null,
    readScreenLines: () => null
  }
}

describe('ptyTuiIdleEvidence', () => {
  it.each([
    ['qoder', 'qoder-trust-dialog'],
    ['qoder-cn', 'qoder-cn-signin']
  ] as const)('requires a live composer for adopted %s panes', (agent, fixture) => {
    const transcript = readFileSync(join(__dirname, '__fixtures__', `${fixture}.txt`), 'utf8')
    const evidence = ptyTuiIdleEvidence(source(agent), makeTuiIdlePty(), () => transcript)
    expect(evidence.readPositiveBodyEvidence()).toBe(false)
  })

  it('keeps adopted idle evidence for other agents', () => {
    const evidence = ptyTuiIdleEvidence(source('claude'), makeTuiIdlePty(), () => '')
    expect(evidence.readPositiveBodyEvidence()).toBe(true)
  })
})
