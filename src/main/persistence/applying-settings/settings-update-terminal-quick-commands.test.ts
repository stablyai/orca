import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalQuickCommand } from '../../../shared/terminal-quick-command-types'
import { MAX_QUICK_COMMANDS } from '../../../shared/terminal-quick-commands'
import {
  getTerminalQuickCommandPromptMessageBytes,
  MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES,
  MAX_TERMINAL_QUICK_COMMANDS_SERIALIZED_BYTES
} from '../../../shared/terminal-quick-command-prompt-limit'
import { REMOTE_RPC_MAX_CONTENT_BYTES } from '../../../shared/remote-rpc-content-budget'
import { MAX_WS_MESSAGE_BYTES } from '../../runtime/rpc/ws-transport'
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

// The largest prompt of one repeated character the message bound admits.
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

// Local saves and paired saves both reach the store here, so this is the one place the bound holds.
describe('updateSettings terminalQuickCommands', () => {
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
        terminalQuickCommands: [agentCommand('review', `${promptAtLimit('x')}x`)]
      })
    ).toThrow(/"review" is 257 KB\. Quick command prompts can be up to 256 KB/)
    expect(operations.scheduleSave).not.toHaveBeenCalled()
  })

  it('refuses a list too large for one paired reply', () => {
    // Forty prompts at the limit total about 10 MB of JSON.
    const commands = Array.from({ length: MAX_QUICK_COMMANDS }, (_, index) =>
      agentCommand(`c${index}`, promptAtLimit('界'))
    )

    expect(() => updateSettings(makeOperations(), { terminalQuickCommands: commands })).toThrow(
      /Shorten or remove a prompt/
    )
  })
})

describe('the quick-command storage bound against every prompt limit on the run path', () => {
  // The worst character for each limit: a C0 control escapes to 6 bytes of JSON, CJK is 3 of UTF-8.
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
    // Legacy E2EE frames are base64 of nonce + MAC + plaintext.
    const inboundPlaintextBytes = Math.floor(MAX_WS_MESSAGE_BYTES / 4) * 3 - 40
    const worstCasePromptBytes = MAX_QUICK_COMMAND_AGENT_PROMPT_MESSAGE_BYTES
    const envelopeReserveBytes = 16 * 1024
    expect(worstCasePromptBytes + envelopeReserveBytes).toBeLessThanOrEqual(inboundPlaintextBytes)
  })
})
