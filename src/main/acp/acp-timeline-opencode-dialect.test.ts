import { afterEach, describe, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { OPENCODE_ACP_DIALECT } from './acp-dialects/opencode-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'

afterEach(closeProviderTimelineRigs)

async function openCodeRig() {
  const rig = await openProviderTimelineRig()
  const translator = new AcpTimelineTranslator({
    sessionId: 'provider-1',
    dialect: OPENCODE_ACP_DIALECT
  })
  const apply = (events: ProviderTimelineEvent[]) => {
    for (const event of events) {
      expect(rig.assembler.apply(event).admission.accepted).toBe(true)
    }
  }
  const update = (body: Record<string, unknown>, at: number) =>
    apply(translator.notification('session/update', { sessionId: 'provider-1', update: body }, at))
  apply(translator.openPrompt('send-1', 1000).events)
  return { rig, translator, apply, update }
}

// The shapes OpenCode's ACP server writes for a shell tool: its output and exit code ride under
// `rawOutput.metadata`, beside the text content.
const bashStart = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call-1',
  title: 'List files',
  kind: 'execute',
  status: 'pending',
  rawInput: { command: 'ls missing', description: 'List files' }
}

describe('OpenCode over ACP', () => {
  it("reads a shell tool's exit code and output from OpenCode's metadata", async () => {
    const { rig, update } = await openCodeRig()
    update(bashStart, 1001)
    update(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        rawOutput: {
          output: 'ls: missing: No such file or directory\n',
          metadata: { output: 'ls: missing: No such file or directory\n', exit: 1 }
        }
      },
      1002
    )
    const tool = (await rig.rows()).find((row) => row.body.kind === 'tool-call')?.body
    expect(tool).toMatchObject({
      kind: 'tool-call',
      state: 'completed',
      exitCode: 1,
      output: { head: 'ls: missing: No such file or directory\n' }
    })
  })

  it('keeps a shared exit code the agent already reported', () => {
    const normalized = OPENCODE_ACP_DIALECT.normalizeToolUpdate!({
      toolCallId: 'call-1',
      rawOutput: { exitCode: 0, metadata: { exit: 3 } }
    })
    expect(normalized.rawOutput).toEqual({ exitCode: 0, metadata: { exit: 3 } })
  })

  it('leaves a tool with no command metadata as it came', () => {
    const plain = { toolCallId: 'call-2', rawOutput: 'done' }
    expect(OPENCODE_ACP_DIALECT.normalizeToolUpdate!(plain)).toBe(plain)
  })

  it('says that "always" lasts only until OpenCode restarts', async () => {
    const { translator, apply, update } = await openCodeRig()
    update(bashStart, 1001)
    const request = translator.request(
      'session/request_permission',
      {
        sessionId: 'provider-1',
        toolCall: { toolCallId: 'call-1', title: 'ls missing', kind: 'execute' },
        options: [
          { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
          { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
        ]
      },
      0
    )
    apply(request.events)
    expect(request.presentation?.body).toMatchObject({
      options: [
        { id: 'once', label: 'Allow once' },
        { id: 'always', label: 'Allow until OpenCode restarts' },
        { id: 'reject', label: 'Reject' }
      ]
    })
    expect(request.presentation?.reply({ kind: 'option', optionId: 'always' })).toEqual({
      outcome: { outcome: 'selected', optionId: 'always' }
    })
  })
})
