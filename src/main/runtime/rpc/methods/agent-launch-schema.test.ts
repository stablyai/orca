import { describe, expect, it } from 'vitest'
import { CreateTerminalTab } from './session-tabs-schemas'
import { AgentLaunchInputSchema, AgentLaunchSpawnRequestSchema } from './agent-launch-spawn-schema'
import { MAX_AGENT_ARGS_CODE_UNITS } from '../../../../shared/custom-tui-agent-fields'

const CUSTOM_ID = 'custom-agent:claude:11111111-2222-4333-8444-555555555555'

describe('legacy launch fields reject custom agent ids', () => {
  it('rejects a custom id on the legacy launchAgent field', () => {
    const parsed = CreateTerminalTab.safeParse({
      worktree: 'w1',
      launchAgent: CUSTOM_ID
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a custom id on the legacy agent preset field', () => {
    const parsed = CreateTerminalTab.safeParse({ worktree: 'w1', agent: CUSTOM_ID })
    expect(parsed.success).toBe(false)
  })

  it('accepts a built-in id on the legacy launchAgent field', () => {
    const parsed = CreateTerminalTab.safeParse({ worktree: 'w1', launchAgent: 'claude' })
    expect(parsed.success).toBe(true)
  })
})

describe('agentLaunch admits custom ids on the sanctioned path', () => {
  it('accepts a custom id in selection.agent', () => {
    const parsed = AgentLaunchSpawnRequestSchema.safeParse({
      selection: { kind: 'agent', agent: CUSTOM_ID },
      prompt: 'do the thing'
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts a default selection with no prompt', () => {
    const parsed = AgentLaunchSpawnRequestSchema.safeParse({
      selection: { kind: 'default' },
      allowEmptyPromptLaunch: true
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an unknown agent id', () => {
    const parsed = AgentLaunchSpawnRequestSchema.safeParse({
      selection: { kind: 'agent', agent: 'not-a-real-agent' }
    })
    expect(parsed.success).toBe(false)
  })

  it('parses through the CreateTerminalTab agentLaunch field', () => {
    const parsed = CreateTerminalTab.safeParse({
      worktree: 'w1',
      agentLaunch: { selection: { kind: 'agent', agent: CUSTOM_ID }, prompt: 'go' }
    })
    expect(parsed.success).toBe(true)
  })
})

// Regression for L4-m10: `unattended` wasn't declared on the schema, so Zod's
// default object parsing silently stripped it — downgrading a caller's
// declared background launch to interactive instead of failing closed.
describe('agentLaunch unattended declaration', () => {
  it('accepts and preserves an unattended background declaration', () => {
    const parsed = AgentLaunchSpawnRequestSchema.safeParse({
      selection: { kind: 'default' },
      allowEmptyPromptLaunch: true,
      unattended: { kind: 'background' }
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.unattended).toEqual({ kind: 'background' })
  })

  it('rejects an unknown unattended kind instead of silently dropping it', () => {
    const parsed = AgentLaunchSpawnRequestSchema.safeParse({
      selection: { kind: 'default' },
      unattended: { kind: 'interactive' }
    })
    expect(parsed.success).toBe(false)
  })

  it('is absent (undefined) rather than stripped-but-truthy when omitted', () => {
    const parsed = AgentLaunchSpawnRequestSchema.safeParse({
      selection: { kind: 'default' }
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.unattended).toBeUndefined()
  })
})

// P1-24: unsaved recipe arg edits ride the launch as client text, so they must
// survive parsing AND be length-bounded like the stored recipe args.
describe('agentLaunch unsaved recipe args', () => {
  it('preserves client-supplied unsaved args instead of stripping them', () => {
    const parsed = AgentLaunchSpawnRequestSchema.safeParse({
      selection: { kind: 'agent', agent: 'claude' },
      sourceRecord: { owner: 'source-control-recipe', id: 'fixChecks' },
      unsavedAgentArgs: '--model sonnet'
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.unsavedAgentArgs).toBe('--model sonnet')
  })

  it('accepts an empty string (the user cleared the args)', () => {
    const parsed = AgentLaunchSpawnRequestSchema.safeParse({
      selection: { kind: 'agent', agent: 'claude' },
      sourceRecord: { owner: 'source-control-recipe', id: 'fixChecks' },
      unsavedAgentArgs: ''
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.unsavedAgentArgs).toBe('')
  })

  it('rejects oversized unsaved args', () => {
    const parsed = AgentLaunchSpawnRequestSchema.safeParse({
      selection: { kind: 'agent', agent: 'claude' },
      sourceRecord: { owner: 'source-control-recipe', id: 'fixChecks' },
      unsavedAgentArgs: 'a'.repeat(MAX_AGENT_ARGS_CODE_UNITS + 1)
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a non-string on the CreateTerminalTab agentLaunch field', () => {
    const parsed = CreateTerminalTab.safeParse({
      worktree: 'w1',
      agentLaunch: {
        selection: { kind: 'agent', agent: 'claude' },
        unsavedAgentArgs: ['--model', 'sonnet']
      }
    })
    expect(parsed.success).toBe(false)
  })
})

describe('agentLaunch resume/fork variant', () => {
  const validKey = { worktreeId: 'wt-1', baseAgent: 'claude', providerSessionId: 'sess-1' }

  it('accepts a resume by session key', () => {
    const parsed = AgentLaunchInputSchema.safeParse({
      resume: { operation: 'resume', sessionKey: validKey }
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts a fork by session key', () => {
    const parsed = AgentLaunchInputSchema.safeParse({
      resume: { operation: 'fork', sessionKey: validKey }
    })
    expect(parsed.success).toBe(true)
  })

  it('still accepts a fresh selection launch on the same input', () => {
    const parsed = AgentLaunchInputSchema.safeParse({
      selection: { kind: 'agent', agent: CUSTOM_ID }
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a non-resumable base in the session key', () => {
    const parsed = AgentLaunchInputSchema.safeParse({
      resume: { operation: 'resume', sessionKey: { ...validKey, baseAgent: 'cursor' } }
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an unknown operation', () => {
    const parsed = AgentLaunchInputSchema.safeParse({
      resume: { operation: 'branch', sessionKey: validKey }
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a provider session id with control characters', () => {
    const parsed = AgentLaunchInputSchema.safeParse({
      resume: { operation: 'resume', sessionKey: { ...validKey, providerSessionId: 'badid' } }
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a leading-dash provider session id (argv injection guard)', () => {
    const parsed = AgentLaunchInputSchema.safeParse({
      resume: { operation: 'resume', sessionKey: { ...validKey, providerSessionId: '--evil' } }
    })
    expect(parsed.success).toBe(false)
  })

  it('parses a resume variant through the CreateTerminalTab agentLaunch field', () => {
    const parsed = CreateTerminalTab.safeParse({
      worktree: 'w1',
      agentLaunch: { resume: { operation: 'resume', sessionKey: validKey } }
    })
    expect(parsed.success).toBe(true)
  })
})

describe('agentLaunch AI Vault resume variant', () => {
  const validEntry = { executionHostId: 'local', agent: 'codex', sessionId: 'vault-1' }

  it('accepts a resume by vault entry', () => {
    const parsed = AgentLaunchInputSchema.safeParse({
      vaultResume: {
        operation: 'resume',
        entry: { ...validEntry, resumeLocator: 'a'.repeat(64) }
      }
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a malformed resume locator', () => {
    const parsed = AgentLaunchInputSchema.safeParse({
      vaultResume: {
        operation: 'resume',
        entry: { ...validEntry, resumeLocator: 'not-a-digest' }
      }
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts a copy operation and a trusted-desktop filePath', () => {
    const parsed = AgentLaunchInputSchema.safeParse({
      vaultResume: { operation: 'copy', entry: { ...validEntry, filePath: '/t/omp.jsonl' } }
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts an ssh execution host', () => {
    const parsed = AgentLaunchInputSchema.safeParse({
      vaultResume: { operation: 'resume', entry: { ...validEntry, executionHostId: 'ssh:box' } }
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an unparseable execution host', () => {
    const parsed = AgentLaunchInputSchema.safeParse({
      vaultResume: { operation: 'resume', entry: { ...validEntry, executionHostId: 'nonsense:x' } }
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an unknown AI Vault agent', () => {
    const parsed = AgentLaunchInputSchema.safeParse({
      vaultResume: { operation: 'resume', entry: { ...validEntry, agent: 'not-an-agent' } }
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an unknown operation', () => {
    const parsed = AgentLaunchInputSchema.safeParse({
      vaultResume: { operation: 'spawn', entry: validEntry }
    })
    expect(parsed.success).toBe(false)
  })

  it('parses a vault resume through the CreateTerminalTab agentLaunch field', () => {
    const parsed = CreateTerminalTab.safeParse({
      worktree: 'w1',
      agentLaunch: { vaultResume: { operation: 'resume', entry: validEntry } }
    })
    expect(parsed.success).toBe(true)
  })
})
