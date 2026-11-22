import { describe, expect, it } from 'vitest'
import { sendMailboxPointerAgentPrompt } from './mailbox-pointer-agent-prompt'
import type { RuntimeAgentPromptWriteOptions } from '../../../terminal/input/agent-prompt-write-options'
import type { RuntimeTerminalSend } from '../../../../../shared/terminal/runtime/runtime-terminal-send-contract'

const NOTICE =
  'You have 1 orchestration message. Run `orca orchestration check --terminal term_worker`.'
const TARGET = {
  terminal: {
    ptyId: 'pty-worker',
    handle: 'term_worker',
    paneKeys: [],
    lastAgentStatus: 'idle' as const,
    lastAgentStatusObservedLive: true
  },
  processIncarnation: 'process-1',
  agent: 'codex'
}

function fixture(initialDraft = '') {
  let draft: string | undefined = initialDraft
  let inputAt: number | null = null
  let screenAvailable = true
  const sent: string[] = []
  const submitted: string[] = []
  const request = {
    target: TARGET,
    prompt: NOTICE,
    requestId: 'pointer-1',
    assertCurrent: () => undefined,
    beforeSubmit: () => submitted.push('reserved')
  }
  return {
    request,
    sent,
    submitted,
    setDraft: (value: string | undefined) => {
      draft = value
    },
    userInput: () => {
      inputAt = 1
    },
    loseScreen: () => {
      screenAvailable = false
    },
    host: {
      getBinding: () => ({ ptyId: 'pty-worker', processIncarnation: 'prompt-process-1' }),
      readScreen: async () => (screenAvailable ? { draft } : null),
      readDrivingInputAt: () => inputAt,
      sendPrompt: async (
        _handle: string,
        prompt: string,
        options: RuntimeAgentPromptWriteOptions
      ): Promise<RuntimeTerminalSend> => {
        await options.beforeWrite?.('pty-worker')
        sent.push(prompt)
        draft = prompt
        await options.beforeWrite?.('pty-worker')
        sent.push('\r')
        return { handle: 'term_worker', accepted: true, bytesWritten: 1 }
      }
    }
  }
}

describe('Codex mailbox prompt ownership', () => {
  it('pastes once into an empty composer and reserves before Enter without claiming consumption', async () => {
    const f = fixture()
    expect(await sendMailboxPointerAgentPrompt(f.host, f.request)).toBe('unverifiable')
    expect(f.sent).toEqual([NOTICE, '\r'])
    expect(f.submitted).toEqual(['reserved'])
  })

  it.each(['my unsent work', NOTICE, `${NOTICE}\n\n${NOTICE}`])(
    'leaves an existing unowned draft untouched: %s',
    async (draft) => {
      const f = fixture(draft)
      expect(await sendMailboxPointerAgentPrompt(f.host, f.request)).toBe('refused')
      expect(f.sent).toEqual([])
      expect(await f.host.readScreen()).toEqual({ draft })
    }
  )

  it.each(['my replacement draft', `${NOTICE}\nmy appended work`, '', undefined])(
    'does not send Enter when the owned notice changed or disappeared: %s',
    async (draft) => {
      const f = fixture()
      f.host.sendPrompt = async (_handle, prompt, options) => {
        await options.beforeWrite?.('pty-worker')
        f.sent.push(prompt)
        f.setDraft(draft)
        await options.beforeWrite?.('pty-worker')
        f.sent.push('\r')
        throw new Error('unexpected Enter')
      }
      expect(await sendMailboxPointerAgentPrompt(f.host, f.request)).toBe('unverifiable')
      expect(f.sent).toEqual([NOTICE])
      expect(f.submitted).toEqual([])
    }
  )

  it('lets the prompt API retry only the still-owned notice and stops when it is taken', async () => {
    const f = fixture()
    f.host.sendPrompt = async (_handle, prompt, options) => {
      await options.beforeWrite?.('pty-worker')
      f.sent.push(prompt)
      f.setDraft(`${prompt}\n`)
      await options.beforeWrite?.('pty-worker')
      f.sent.push('\r')
      await options.beforeWrite?.('pty-worker')
      f.sent.push('\r')
      f.setDraft('')
      await options.beforeWrite?.('pty-worker')
      f.sent.push('\r')
      throw new Error('unexpected third Enter')
    }
    expect(await sendMailboxPointerAgentPrompt(f.host, f.request)).toBe('unverifiable')
    expect(f.sent).toEqual([NOTICE, '\r', '\r'])
    expect(f.submitted).toEqual(['reserved'])
  })

  it('allows the whole owned notice when Codex paints it across display rows', async () => {
    const f = fixture()
    f.host.sendPrompt = async (_handle, prompt, options) => {
      await options.beforeWrite?.('pty-worker')
      f.sent.push(prompt)
      f.setDraft(
        'You have 1 orchestration message. Run `orca orchestration check\n--terminal term_worker`.'
      )
      await options.beforeWrite?.('pty-worker')
      f.sent.push('\r')
      return { handle: 'term_worker', accepted: true, bytesWritten: 1 }
    }
    expect(await sendMailboxPointerAgentPrompt(f.host, f.request)).toBe('unverifiable')
    expect(f.sent).toEqual([NOTICE, '\r'])
  })

  it.each(['screen unavailable', 'driving input', 'binding changed', 'write threw'])(
    '%s remains unconfirmed after paste admission',
    async (change) => {
      const f = fixture()
      f.host.sendPrompt = async (_handle, prompt, options) => {
        await options.beforeWrite?.('pty-worker')
        f.sent.push(prompt)
        f.setDraft(prompt)
        if (change === 'screen unavailable') {
          f.loseScreen()
        }
        if (change === 'driving input') {
          f.userInput()
        }
        if (change === 'binding changed') {
          f.request.assertCurrent = () => {
            throw new Error('stale')
          }
        }
        if (change === 'write threw') {
          throw new Error('settlement lost')
        }
        await options.beforeWrite?.('pty-worker')
        f.sent.push('\r')
        throw new Error('unexpected Enter')
      }
      expect(await sendMailboxPointerAgentPrompt(f.host, f.request)).toBe('unverifiable')
      expect(f.sent).toEqual([NOTICE])
    }
  )
})
