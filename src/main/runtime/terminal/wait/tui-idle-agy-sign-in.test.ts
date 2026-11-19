/** agy 1.5.12 reports OSC 7501 blocked:auth both while it silently signs in and at its login menu (#44603, #38901). */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'

const SIGN_IN_REQUIRED = Buffer.from('Sign in required').toString('base64')
const AUTH_BLOCKED = `\x1b]7501;state=blocked:kind=auth:app=antigravity:msg=${SIGN_IN_REQUIRED}\x07`
const WELCOME = '\r\n Welcome to the Antigravity CLI. You are currently not signed in.\r\n\r\n'
const COMPOSER =
  '\x1b[2J\x1b[H Antigravity CLI 1.5.12\r\n Gemini 4 Carbon (Medium)\r\n\r\n' +
  `${'─'.repeat(60)}\r\n> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)\r\n` +
  `${'─'.repeat(60)}\r\n? for shortcuts`

async function startAgyWait() {
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'agy',
    foregroundProcess: 'agy',
    launchAgent: 'antigravity',
    data: ''
  })
  vi.useFakeTimers()
  const write = (chunk: string) => runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, Date.now())
  const settled = vi.fn()
  return {
    write,
    settled,
    wait: () => {
      const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
      wait.then(settled, () => {})
      return wait
    }
  }
}

describe('tui-idle on agy reporting a sign-in block', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds through a saved-credential sign-in slower than the persistence window', async () => {
    const { write, settled, wait } = await startAgyWait()
    write(`${AUTH_BLOCKED}${WELCOME} ⣷  Signing in...`)
    const result = wait()
    // agy repaints its spinner every 100ms until the sign-in round trips finish.
    for (let frame = 0; frame < 80; frame += 1) {
      await vi.advanceTimersByTimeAsync(100)
      write('\x1b[1G ⣯ ')
    }
    expect(settled).not.toHaveBeenCalled()

    write(`\x1b]7501;state=idle:app=antigravity\x07${COMPOSER}`)
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(result).resolves.toMatchObject({ satisfied: true })
  })

  it('fails fast once agy rests at its login menu', async () => {
    const { write, wait } = await startAgyWait()
    write(
      `${AUTH_BLOCKED}${WELCOME} Select login method:\r\n > 1. Google OAuth\r\n2. Use a Google Cloud project\r\n`
    )
    const result = wait()
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(result).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-sign-in-prompt'
    })
  })

  it('drops the sign-in block when only the facet moves off auth', async () => {
    const { write, settled, wait } = await startAgyWait()
    write(`${AUTH_BLOCKED}${WELCOME} Select login method:\r\n > 1. Google OAuth\r\n`)
    // Same projected row, so only the facet carries the change.
    write(`\x1b]7501;state=blocked:app=antigravity:msg=${SIGN_IN_REQUIRED}\x07`)
    void wait()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(settled).not.toHaveBeenCalled()
  })
})
