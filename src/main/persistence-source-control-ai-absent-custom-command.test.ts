import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, testState, writeDataFile } from './persistence-test-harness'
import { getDefaultSourceControlAiSettings } from '../shared/source-control-ai'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

// Crash report 21699b66 (v1.4.199): JSON.stringify drops a key holding undefined, so a profile
// that hit the bug once reloads with `customAgentCommand` absent from BOTH blocks. The load path
// must hand the renderer a string again instead of re-deriving undefined.
const { customAgentCommand: _dropped, ...sourceControlAiWithoutCustomCommand } =
  getDefaultSourceControlAiSettings()

describe('loading a profile whose persisted customAgentCommand is absent', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('restores the string in both the new and the legacy block', () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        commitMessageAi: {
          enabled: true,
          agentId: null,
          selectedModelByAgent: {},
          selectedThinkingByModel: {},
          customPrompt: ''
        },
        sourceControlAi: sourceControlAiWithoutCustomCommand
      }
    })

    const settings = createStore().getSettings()
    expect(settings.sourceControlAi?.customAgentCommand).toBe('')
    expect(settings.commitMessageAi?.customAgentCommand).toBe('')
  })

  it('keeps a saved custom command that the legacy block predates', () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {
        commitMessageAi: {
          enabled: true,
          agentId: 'custom',
          selectedModelByAgent: {},
          selectedThinkingByModel: {},
          customPrompt: ''
        },
        sourceControlAi: {
          ...getDefaultSourceControlAiSettings(),
          agentId: 'custom',
          customAgentCommand: 'my-generator {prompt}'
        }
      }
    })

    const settings = createStore().getSettings()
    expect(settings.sourceControlAi?.customAgentCommand).toBe('my-generator {prompt}')
  })
})
