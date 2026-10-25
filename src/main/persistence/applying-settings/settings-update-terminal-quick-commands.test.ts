import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalQuickCommand } from '../../../shared/terminal-quick-command-types'
import {
  getTerminalQuickCommandPromptMessageBytes,
  MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES,
  MAX_TERMINAL_QUICK_COMMANDS_SERIALIZED_BYTES
} from '../../../shared/terminal-quick-command-prompt-limit'
import { REMOTE_RPC_MAX_CONTENT_BYTES } from '../../../shared/remote-rpc-content-budget'
import { REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES } from '../../../shared/remote-runtime-memory-limits'
import { updateSettings, type SettingsMutationOperations } from './settings-update'
import {
  CreateAgentSessionParams,
  MAX_PROMPT_BYTES as CREATE_MAX_PROMPT_BYTES
} from '../../../shared/rpc-contract/agent-session-params'
import { MAX_PROMPT_BYTES as STRUCTURED_MAX_PROMPT_BYTES } from '../../../shared/rpc-contract/structured-agent-session-params'

function makeOperations(): SettingsMutationOperations {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields updateSettings reads for this setting.
    state: { settings: { terminalQuickCommands: [] }, repos: [] } as unknown as PersistedState,
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: vi.fn()
  }
}

function promptAtLimit(character: string): string {
  const overhead = getTerminalQuickCommandPromptMessageBytes('')
  const perCharacter = getTerminalQuickCommandPromptMessageBytes(character) - overhead
  return character.repeat(
    Math.floor((MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES - overhead) / perCharacter)
  )
}

function agentCommand(id: string, prompt: string): TerminalQuickCommand {
  return {
    id,
    label: id,
    action: 'agent-prompt',
    agent: 'claude',
    prompt,
    scope: { type: 'global' }
  }
}

// Local and paired saves enforce prompt bounds at this shared store entrypoint.
describe('updateSettings terminalQuickCommands', () => {
  it('stores every command in a list larger than forty, including missing projects', () => {
    const commands = Array.from({ length: 100 }, (_, index) => ({
      ...agentCommand(`command-${index}`, 'Review this project'),
      scope: { type: 'repo' as const, repoId: `missing-project-${index}` }
    }))
    const operations = makeOperations()

    const saved = updateSettings(operations, { terminalQuickCommands: commands })

    expect(saved.terminalQuickCommands).toEqual(commands)
    expect(operations.state.settings.terminalQuickCommands).toEqual(commands)
  })

  it('stores a prompt at the limit whole', () => {
    const prompt = promptAtLimit('x')
    const saved = updateSettings(makeOperations(), {
      terminalQuickCommands: [agentCommand('review', prompt)]
    })

    expect(saved.terminalQuickCommands?.[0]).toMatchObject({ prompt })
  })

  it('refuses a prompt over the limit rather than trimming it', () => {
    const operations = makeOperations()

    expect(() =>
      updateSettings(operations, {
        opencodeSessionCookie: '',
        httpProxyUrl: '',
        terminalQuickCommands: [agentCommand('review', `${promptAtLimit('x')}x`)]
      })
    ).toThrow(/"review" is 257 KB\. Quick command prompts can be up to 256 KB/)
    expect(operations.removeRetainedBlob).not.toHaveBeenCalled()
    expect(operations.scheduleSave).not.toHaveBeenCalled()
  })

  it('refuses a list too large for one paired reply', () => {
    const commands = Array.from({ length: 40 }, (_, index) =>
      agentCommand(`c${index}`, promptAtLimit('界'))
    )

    expect(() => updateSettings(makeOperations(), { terminalQuickCommands: commands })).toThrow(
      /Shorten or remove a prompt/
    )
  })
})

describe('the quick-command storage bound against every prompt limit on the run path', () => {
  // C0 controls cost six JSON bytes; CJK characters cost three UTF-8 bytes.
  const worstForJson = promptAtLimit('\u0001')
  const worstForUtf8 = promptAtLimit('界')

  it('measures the prompt the way a chat message measures its blocks', () => {
    expect(MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES).toBe(STRUCTURED_MAX_PROMPT_BYTES)
    expect(getTerminalQuickCommandPromptMessageBytes(worstForJson)).toBe(
      Buffer.byteLength(JSON.stringify([{ type: 'text', text: worstForJson }]), 'utf8')
    )
  })

  it('fits a structured chat message, which caps the JSON of its blocks', () => {
    const blocks = [{ type: 'text', text: worstForJson }]
    expect(Buffer.byteLength(JSON.stringify(blocks), 'utf8')).toBeLessThanOrEqual(
      STRUCTURED_MAX_PROMPT_BYTES
    )
  })

  it('fits a paired create, which caps the prompt in UTF-8 bytes', () => {
    expect(Buffer.byteLength(worstForUtf8, 'utf8')).toBeLessThanOrEqual(CREATE_MAX_PROMPT_BYTES)
    expect(
      CreateAgentSessionParams.safeParse({
        clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
        worktree: 'id:worktree-1',
        agent: 'claude',
        prompt: worstForUtf8
      }).success
    ).toBe(true)
  })
})

describe('the quick-command storage bound against the paired transports', () => {
  it('fits a saved list in one reply', () => {
    expect(MAX_TERMINAL_QUICK_COMMANDS_SERIALIZED_BYTES + 64 * 1024).toBeLessThanOrEqual(
      REMOTE_RPC_MAX_CONTENT_BYTES
    )
  })

  it('fits one saved command in an inbound frame at the worst JSON escape', () => {
    const worstCasePromptBytes = MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES
    const envelopeReserveBytes = 16 * 1024
    expect(worstCasePromptBytes + envelopeReserveBytes).toBeLessThanOrEqual(
      REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES
    )
  })
})
