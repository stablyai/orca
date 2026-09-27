import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'

const ready = readFileSync(
  new URL('./__fixtures__/kimi-sessionless-ready.txt', import.meta.url),
  'utf8'
)
const picker = readFileSync(
  new URL('./__fixtures__/kimi-sessionless-model-picker.txt', import.meta.url),
  'utf8'
)

async function pane(data: string, connectionId?: string) {
  return createTranscriptPane({
    paneTitle: 'kimi',
    foregroundProcess: 'kimi',
    launchAgent: 'kimi',
    data,
    connectionId
  })
}

describe('Kimi sessionless startup readiness', () => {
  it.each(['working', 'blocked', 'waiting'])(
    'does not revive retained startup after %s status ages out',
    async (state) => {
      const { runtime, handle } = await pane(ready)
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        `${String.fromCharCode(27)}]9999;${JSON.stringify({ state, agentType: 'kimi' })}${String.fromCharCode(7)}`,
        Date.now()
      )
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000)
      try {
        await expect(
          runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
        ).rejects.toThrow('timeout')
      } finally {
        clock.mockRestore()
      }
    }
  )

  it.each<TuiAgent>(['codex', 'claude'])(
    'does not settle a working %s pane displaying the Kimi capture',
    async (agent) => {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: agent,
        foregroundProcess: agent,
        launchAgent: agent,
        data: ready
      })
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        `${String.fromCharCode(27)}]9999;${JSON.stringify({ state: 'working', agentType: agent })}${String.fromCharCode(7)}`,
        Date.now()
      )
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
      ).rejects.toThrow('timeout')
    }
  )

  it('does not authorize sessionless startup before pane agent identity is known', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: null,
      data: ready
    })
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
    ).rejects.toThrow('timeout')
  })

  it('recognizes startup from a confirmed foreground Kimi without launch metadata', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: 'kimi',
      data: ready
    })
    await runtime.refreshPtyForegroundAgentFromController(TRANSCRIPT_PANE_PTY_ID)
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
    ).resolves.toMatchObject({ satisfied: true })
  })

  it('settles a wait registered before the startup frame arrives', async () => {
    const { runtime, handle } = await pane('')
    const result = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 5000 })
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, ready, Date.now())
    await expect(result).resolves.toMatchObject({ satisfied: true })
  })

  it.each([undefined, 'ssh-host'])(
    'recognizes the captured empty composer on %s',
    async (connectionId) => {
      const { runtime, handle } = await pane(ready, connectionId)
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
      ).resolves.toMatchObject({ satisfied: true })
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
      ).resolves.toMatchObject({ satisfied: true })
    }
  )

  it('does not mistake a captured model picker for the empty composer', async () => {
    const { runtime, handle } = await pane(picker)
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
    ).rejects.toThrow('timeout')
  })

  it.each(['working', 'blocked', 'waiting'])(
    'does not let retained startup text override %s',
    async (state) => {
      const { runtime, handle } = await pane(ready)
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        `${String.fromCharCode(27)}]9999;${JSON.stringify({ state, agentType: 'kimi' })}${String.fromCharCode(7)}`,
        Date.now()
      )
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
      ).rejects.toThrow('timeout')
    }
  )

  it('does not accept old startup text after new ordinary output', async () => {
    const { runtime, handle } = await pane(ready)
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\r\nConnecting to provider...\r\n', Date.now())
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
    ).rejects.toThrow('timeout')
  })
})
