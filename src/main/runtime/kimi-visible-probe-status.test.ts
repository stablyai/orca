import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeTerminalRead } from '../../shared/runtime-types'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { isKnownReadyPromptPreview } from './terminal-wait-detection'

const ready = readFileSync(
  new URL('./__fixtures__/kimi-sessionless-ready.txt', import.meta.url),
  'utf8'
)

async function kimiPane(data = '') {
  return createTranscriptPane({
    paneTitle: 'kimi',
    foregroundProcess: 'kimi',
    launchAgent: 'kimi',
    data
  })
}

async function pendingProbe(agent: TuiAgent | null = 'kimi') {
  const captured = await kimiPane(ready)
  const snapshot = await captured.runtime.readTerminal(captured.handle, { limit: 100 })
  expect(isKnownReadyPromptPreview(snapshot.tail.join('\n'), 'kimi')).toBe(true)

  const { runtime, handle } = await createTranscriptPane({
    paneTitle: agent ?? 'Terminal',
    foregroundProcess: agent,
    launchAgent: agent ?? undefined,
    data: ''
  })
  let release!: (value: RuntimeTerminalRead) => void
  const read = vi.spyOn(runtime, 'readTerminal').mockImplementation(
    () =>
      new Promise<RuntimeTerminalRead>((resolve) => {
        release = resolve
      })
  )
  const result = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 200 })
  expect(read).toHaveBeenCalledWith(
    handle,
    {},
    expect.objectContaining({ visibleScreenOnly: true })
  )
  const sendStatus = (state: string) =>
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      `${String.fromCharCode(27)}]9999;${JSON.stringify({ state, agentType: 'kimi' })}${String.fromCharCode(7)}`,
      Date.now()
    )
  const finishRead = (tail = snapshot.tail) =>
    release({ ...snapshot, handle, source: 'screen', tail })
  return { runtime, handle, result, sendStatus, finishRead }
}

describe('Kimi status arriving during a visible-screen probe', () => {
  it('rejects a predecessor screen when the PTY incarnation changes under the same handle', async () => {
    const { runtime, handle, result, finishRead } = await pendingProbe()
    const check = expect(result).rejects.toThrow('timeout')
    runtime.registerPty(TRANSCRIPT_PANE_PTY_ID, 'wt-1', null, {
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      incarnationId: 'inc-2',
      terminalHandle: handle,
      agentLaunchAuthority: { launchToken: 'replacement-launch', launchAgent: 'kimi' }
    })
    finishRead()
    await check
  })

  it('does not authorize an unidentified pane from a Kimi screen alone', async () => {
    const { result, finishRead } = await pendingProbe(null)
    const check = expect(result).rejects.toThrow('timeout')
    finishRead()
    await check
  })

  it.each<TuiAgent>(['codex', 'claude'])(
    'rejects a Kimi snapshot when an unknown pane becomes %s during the read',
    async (agent) => {
      const { runtime, result, finishRead } = await pendingProbe(null)
      const check = expect(result).rejects.toThrow('timeout')
      runtime.registerPty(TRANSCRIPT_PANE_PTY_ID, 'wt-1', null, {
        tabId: 'tab-1',
        leafId: '11111111-1111-4111-8111-111111111111',
        incarnationId: 'inc-1',
        agentLaunchAuthority: { launchToken: 'identified-during-read', launchAgent: agent }
      })
      finishRead()
      await check
    }
  )

  it.each(['working', 'blocked', 'waiting'])(
    'does not treat a 31-minute-old %s status as completion in the probe',
    async (state) => {
      const { result, sendStatus, finishRead } = await pendingProbe()
      const check = expect(result).rejects.toThrow('timeout')
      sendStatus(state)
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000)
      try {
        finishRead()
        await check
      } finally {
        clock.mockRestore()
      }
    }
  )

  it.each(['working', 'blocked', 'waiting'])(
    'does not settle a stale ready snapshot after %s arrives',
    async (state) => {
      const { result, sendStatus, finishRead } = await pendingProbe()
      const check = expect(result).rejects.toThrow('timeout')
      sendStatus(state)
      finishRead()
      await check
    }
  )

  it('accepts a ready snapshot with no first-party status', async () => {
    const { result, finishRead } = await pendingProbe()
    finishRead()
    await expect(result).resolves.toMatchObject({ satisfied: true })
  })

  it('accepts startup when an unknown pane becomes Kimi during the read', async () => {
    const { runtime, result, finishRead } = await pendingProbe(null)
    runtime.registerPty(TRANSCRIPT_PANE_PTY_ID, 'wt-1', null, {
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      incarnationId: 'inc-1',
      agentLaunchAuthority: { launchToken: 'identified-during-read', launchAgent: 'kimi' }
    })
    finishRead()
    await expect(result).resolves.toMatchObject({ satisfied: true })
  })

  it('accepts completion after a working status ages past 30 minutes', async () => {
    const { result, sendStatus, finishRead } = await pendingProbe()
    sendStatus('working')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000)
    try {
      sendStatus('done')
      finishRead()
      await expect(result).resolves.toMatchObject({ satisfied: true })
    } finally {
      clock.mockRestore()
    }
  })

  it('uses the latest status when a working agent finishes during the read', async () => {
    const { result, sendStatus, finishRead } = await pendingProbe()
    sendStatus('working')
    sendStatus('done')
    finishRead()
    await expect(result).resolves.toMatchObject({ satisfied: true })
  })

  it('still reports a blocked prompt when first-party status is waiting', async () => {
    const { result, sendStatus, finishRead } = await pendingProbe()
    sendStatus('waiting')
    finishRead(['Do you trust the files in this folder?'])
    await expect(result).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-trust-workspace'
    })
  })
})
