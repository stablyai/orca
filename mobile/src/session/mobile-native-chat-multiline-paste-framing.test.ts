import { describe, expect, it } from 'vitest'
import {
  sendMobileNativeChatMessageWithOutcome,
  typeMobileNativeChatCommandWithOutcome
} from './mobile-native-chat-send'
import { retireLandedMobileNativeChatPending } from './mobile-native-chat-pending-retirement'
import { sendMobileNativeChatPermissionResponse } from './mobile-native-chat-permission-send'
import { buildMobileQuickCommandLaunch } from '../terminal/quick-commands'
import { normalizeNativeChatUserText } from '../../../src/shared/native-chat-image-transcript-markers'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'

const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
const ESCAPE = '\u001b'
const ESCAPE_SUBSTITUTE = '\u241b'
const CLEAR_INPUT = '\u0015'

type Sent = { text: string; enter: boolean }

function recordingClient(sent: Sent[]): RpcClient {
  return {
    sendRequest: async (_method: string, params: unknown) => {
      const sendParams = params as { text: string; enter: boolean }
      sent.push({ text: sendParams.text, enter: sendParams.enter })
      return { ok: true, result: { send: { accepted: true } } }
    }
  } as unknown as RpcClient
}

function userTurn(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    source: 'transcript',
    blocks: [{ type: 'text', text }]
  } as unknown as NativeChatMessage
}

describe('mobile native chat multi-line framing', () => {
  it('frames an opted-in multi-line body so no newline reaches the TUI as Enter', async () => {
    const sent: Sent[] = []

    const outcome = await sendMobileNativeChatMessageWithOutcome({
      client: recordingClient(sent),
      terminal: 't1',
      text: 'first line\nsecond line',
      framePasteWhenMultiline: true
    })

    expect(outcome).toBe('accepted')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text.startsWith(PASTE_START)).toBe(true)
    expect(sent[0]!.text.endsWith(PASTE_END)).toBe(true)
    expect(sent[0]!.text).not.toContain('\n')
    // Submit stays a separate host write; the body carries no trailing CR.
    expect(sent[0]!.enter).toBe(true)
  })

  it('keeps the clear byte outside the frame', async () => {
    const sent: Sent[] = []

    await sendMobileNativeChatMessageWithOutcome({
      client: recordingClient(sent),
      terminal: 't1',
      text: 'first line\nsecond line',
      clearInputFirst: true,
      framePasteWhenMultiline: true
    })

    expect(sent[0]!.text.startsWith(`${CLEAR_INPUT}${PASTE_START}`)).toBe(true)
  })

  it('leaves an opted-in single-line body byte-identical', async () => {
    const sent: Sent[] = []

    await sendMobileNativeChatMessageWithOutcome({
      client: recordingClient(sent),
      terminal: 't1',
      text: 'one line',
      framePasteWhenMultiline: true
    })

    expect(sent[0]!.text).toBe('one line')
  })

  it('never frames a caller that did not opt in', async () => {
    const sent: Sent[] = []

    await sendMobileNativeChatMessageWithOutcome({
      client: recordingClient(sent),
      terminal: 't1',
      text: 'first line\nsecond line'
    })

    expect(sent[0]!.text).toBe('first line\nsecond line')
  })
})

describe('control paths stay unframed', () => {
  it('writes a slash command one unframed key at a time, ending in a bare submit', async () => {
    const sent: Sent[] = []

    await typeMobileNativeChatCommandWithOutcome({
      client: recordingClient(sent),
      terminal: 't1',
      command: '/model'
    })

    expect(sent.every((write) => !write.text.includes(PASTE_START))).toBe(true)
    expect(sent.at(-1)!.text).toBe('\r')
    expect(sent.every((write) => write.enter === false)).toBe(true)
  })

  it('writes a permission choice unframed', async () => {
    const sent: Sent[] = []

    await sendMobileNativeChatPermissionResponse({
      client: recordingClient(sent),
      terminal: 't1',
      text: '2',
      deviceToken: null
    })

    expect(sent[0]!.text).toBe('2')
  })

  it('keeps a multi-line insert-only quick command an unframed shell command', () => {
    // Guards the overloaded initialPrompt seam: the same send carries prose and
    // shell, so framing must never be attached to it.
    const launch = buildMobileQuickCommandLaunch({
      label: 'two liner',
      command: 'echo one\necho two',
      appendEnter: false
    } as never)

    expect(launch?.options.initialPrompt).toBe('echo one\necho two')
    expect(launch?.options.enter).toBe(false)
  })
})

describe('framed prose still retires its optimistic bubble', () => {
  const pending = [
    {
      id: 'pending-1',
      text: `first${ESCAPE} line\nsecond line`,
      expectedOccurrence: 1,
      baselineTailMessageId: null,
      baselineResolved: true
    }
  ]

  it('reconciles an escape the frame replaced with its printable substitute', () => {
    // The agent echoes what it received, so the transcript carries U+241B while
    // the pending echo still holds the raw byte.
    const transcript = [userTurn('m1', `first${ESCAPE_SUBSTITUTE} line\rsecond line`)]

    expect(retireLandedMobileNativeChatPending(transcript, pending, new Set())).toHaveLength(0)
  })

  it('treats CR and LF separators as the same reconciliation key', () => {
    expect(normalizeNativeChatUserText('a\nb')).toBe(normalizeNativeChatUserText('a\rb'))
  })
})

describe('retirement invariants the fix relies on', () => {
  const pending = [
    {
      id: 'pending-1',
      text: 'first line\nsecond line',
      expectedOccurrence: 1,
      baselineTailMessageId: null,
      baselineResolved: true
    }
  ]

  it('pins the bubble when the TUI split the draft into one turn per line', () => {
    const split = [userTurn('m1', 'first line'), userTurn('m2', 'second line')]

    expect(retireLandedMobileNativeChatPending(split, pending, new Set())).toHaveLength(1)
  })

  it('retires the bubble when the draft landed as one turn', () => {
    const whole = [userTurn('m1', 'first line\nsecond line')]

    expect(retireLandedMobileNativeChatPending(whole, pending, new Set())).toHaveLength(0)
  })
})
