import { expect, it } from 'vitest'
import { AcpAgentError } from '../transport/acp-errors'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import { GOOSE_ACP_DIALECT } from './goose-dialect'

// Captured from Goose 1.60.2 running `orca bot connectors` outside a bot's chat.
const CALL: ToolCallUpdate = {
  toolCallId: 'call_1',
  title: 'shell · orca bot connectors',
  rawInput: { command: 'orca bot connectors' },
  _meta: { goose: { toolCall: { toolName: 'shell', extensionName: 'developer' } } }
}
const RESULT: ToolCallUpdate = {
  toolCallId: 'call_1',
  status: 'failed',
  content: [
    {
      type: 'content',
      content: { type: 'text', text: "Run this from a bot's chat.\n\nCommand exited with code 1" }
    }
  ],
  rawOutput: { stdout: '', stderr: "Run this from a bot's chat.", exit_code: 1 }
}

it('names a call by its tool, not its title', () => {
  expect(GOOSE_ACP_DIALECT.toolName!(CALL)).toBe('shell')
})

it("reads a shell result's exit code and keeps Goose's own output text", () => {
  expect(GOOSE_ACP_DIALECT.normalizeToolUpdate!(RESULT)).toMatchObject({
    rawOutput: { exitCode: 1 },
    content: [{ type: 'content', content: { type: 'text', text: "Run this from a bot's chat." } }]
  })
})

it('labels approval options Goose names by their kind', () => {
  const presentation = GOOSE_ACP_DIALECT.request!('session/request_permission', {
    sessionId: '20261120_5',
    toolCall: { ...CALL, kind: 'other', status: 'pending' },
    options: ['allow_always', 'allow_once', 'reject_once', 'reject_always'].map((kind) => ({
      optionId: kind,
      name: kind,
      kind
    }))
  })
  expect(
    presentation?.body.kind === 'approval' && presentation.body.options.map((o) => o.label)
  ).toEqual(['Always allow', 'Allow', 'Deny', 'Always deny'])
})

it('asks to sign in when Goose has no provider or key configured', () => {
  const failure = (data: string) => new AcpAgentError(-32603, 'Internal error', data)
  expect(
    GOOSE_ACP_DIALECT.authenticationRequired!(
      failure('Failed to resolve provider and model: Configuration value not found: GOOSE_PROVIDER')
    )
  ).toBe(true)
  expect(
    GOOSE_ACP_DIALECT.authenticationRequired!(
      failure('Error getting agent reply: Configuration value not found: ANTHROPIC_API_KEY')
    )
  ).toBe(true)
  expect(
    GOOSE_ACP_DIALECT.authenticationRequired!(failure('Error getting agent reply: timed out'))
  ).toBe(false)
})
