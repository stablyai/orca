import { describe, expect, it } from 'vitest'
import {
  asSupportedBranchRenameAgent,
  pickBranchRenameGenerationAgent
} from './branch-rename-generation-agent'

describe('asSupportedBranchRenameAgent', () => {
  it('accepts agents with a Source Control AI generation contract', () => {
    expect(asSupportedBranchRenameAgent('claude')).toBe('claude')
    expect(asSupportedBranchRenameAgent('codex')).toBe('codex')
  })

  it('rejects missing, blank, and unknown agents', () => {
    expect(asSupportedBranchRenameAgent(undefined)).toBeUndefined()
    expect(asSupportedBranchRenameAgent(null)).toBeUndefined()
    expect(asSupportedBranchRenameAgent('')).toBeUndefined()
    expect(asSupportedBranchRenameAgent('not-an-agent')).toBeUndefined()
  })

  it('rejects known TUI agents without a generation contract', () => {
    // claude-agent-teams is launchable but has no non-interactive SC AI spec.
    expect(asSupportedBranchRenameAgent('claude-agent-teams')).toBeUndefined()
  })
})

describe('pickBranchRenameGenerationAgent', () => {
  it('prefers a supported workspace agent over the configured SC AI default', () => {
    expect(pickBranchRenameGenerationAgent('codex', 'claude')).toBe('claude')
  })

  it('keeps the configured agent when the workspace agent is unsupported', () => {
    expect(pickBranchRenameGenerationAgent('codex', 'claude-agent-teams')).toBe('codex')
    expect(pickBranchRenameGenerationAgent('codex', undefined)).toBe('codex')
    expect(pickBranchRenameGenerationAgent('custom', 'not-an-agent')).toBe('custom')
  })

  it('keeps a custom configured agent when workspace has no supported generation agent', () => {
    expect(pickBranchRenameGenerationAgent('custom', undefined)).toBe('custom')
  })
})
