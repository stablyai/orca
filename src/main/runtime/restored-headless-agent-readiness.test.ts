import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID,
  waitForTranscriptIdle
} from './agent-transcript-pane-test-harness'
import { readRuntimeFixture, replayTranscript } from './agent-transcript-replay-test-harness'
import type { PtyProviderBufferSnapshot } from '../providers/types'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

async function busyCodexTranscript(): Promise<string> {
  const name = 'codex-0-158-0-timed-turn'
  const data = readRuntimeFixture(name)
  const timing: { chunks: [number, number][] } = JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', `${name}.timing.json`), 'utf8')
  )
  let offset = 0
  const chunks = timing.chunks.map(([, length]) => {
    const chunk = data.slice(offset, offset + length)
    offset += length
    return chunk
  })
  let index = 0
  let transcript = ''
  for await (const frame of replayTranscript(chunks, 120, 40)) {
    transcript += chunks[index++]
    if (frame.screenLines.join('\n').includes('to interrupt)')) {
      return transcript
    }
  }
  throw new Error('recorded Codex turn has no busy screen')
}

async function restoredCodex(data: string) {
  const pane = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: 'codex',
    launchAgent: 'codex',
    headless: true,
    data: '',
    size: { cols: 120, rows: 40 }
  })
  const serializeProviderBuffer = vi.fn(async (): Promise<PtyProviderBufferSnapshot> => ({
    data,
    cols: 120,
    rows: 40,
    seq: 100,
    source: 'headless'
  }))
  const confirmForegroundProcess = vi.fn(async () => 'codex')
  const controller = {
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'codex',
    confirmForegroundProcess,
    serializeProviderBuffer
  }
  pane.runtime.setPtyController(controller)
  const pty = Reflect.get(pane.runtime, 'ptysById').get(TRANSCRIPT_PANE_PTY_ID)
  pty.tailBuffer = ['retained output from before attachment']
  Reflect.get(pane.runtime, 'providerSnapshotPreferredPtys').add(TRANSCRIPT_PANE_PTY_ID)
  expect(pty.lastOutputAt).toBeNull()
  expect(
    Reflect.apply(Reflect.get(pane.runtime, 'readLiveTerminalScreenLines'), pane.runtime, [
      TRANSCRIPT_PANE_PTY_ID
    ])
  ).toBeNull()
  return { ...pane, pty, controller, serializeProviderBuffer, confirmForegroundProcess }
}

describe('restored headless Codex provider evidence', () => {
  it('settles a recorded idle composer with a clockless retained tail and unavailable local grid', async () => {
    const pane = await restoredCodex(readRuntimeFixture('codex-0-158-0-timed-turn'))
    await expect(waitForTranscriptIdle(pane, 8_000)).resolves.toMatchObject({ satisfied: true })
    expect(pane.serializeProviderBuffer).toHaveBeenCalledTimes(2)
    expect(pane.confirmForegroundProcess).toHaveBeenCalledWith(TRANSCRIPT_PANE_PTY_ID)
    expect(pane.pty.lastOutputAt).toBeNull()
    expect(pane.pty.lastExplicitAgentStatus).toBeFalsy()
  })

  it('keeps a recorded busy composer pending even when its provider sequence stays fixed', async () => {
    const pane = await restoredCodex(await busyCodexTranscript())
    await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
  })

  it.each(['codex-0-158-0-trustprompt', 'codex-0-158-0-approval'])(
    'refuses the recorded startup or approval dialog %s',
    async (name) => {
      const pane = await restoredCodex(readRuntimeFixture(name))
      const wait = await waitForTranscriptIdle(pane, 8_000)
      expect(wait.satisfied).toBe(false)
      expect(wait.status).toBe('running')
      expect(wait.blockedReason).toBeDefined()
    }
  )

  it('keeps a fresh working status ahead of a quiet provider composer', async () => {
    const pane = await restoredCodex(readRuntimeFixture('codex-0-158-0-timed-turn'))
    pane.pty.lastExplicitAgentStatus = { state: 'working', updatedAt: Date.now() }
    await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
  })

  it('leaves provider output that advanced during the quiet window pending', async () => {
    const pane = await restoredCodex(readRuntimeFixture('codex-0-158-0-timed-turn'))
    let seq = 100
    pane.serializeProviderBuffer.mockImplementation(async () => ({
      data: readRuntimeFixture('codex-0-158-0-timed-turn'),
      cols: 120,
      rows: 40,
      seq: seq++,
      source: 'headless'
    }))
    await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
  })

  it('does not reuse a concurrent frame captured before the quiet window ended', async () => {
    const data = readRuntimeFixture('codex-0-158-0-timed-turn')
    const pane = await restoredCodex(data)
    const idle: PtyProviderBufferSnapshot = {
      data,
      cols: 120,
      rows: 40,
      seq: 100,
      source: 'headless'
    }
    const delayed = Promise.withResolvers<PtyProviderBufferSnapshot>()
    pane.serializeProviderBuffer
      .mockImplementationOnce(async () => idle)
      .mockImplementationOnce(() => delayed.promise)
      .mockImplementation(async () => ({ ...idle, seq: 101 }))
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
    })
    try {
      const waiting = pane.runtime.waitForTerminal(pane.handle, {
        condition: 'tui-idle',
        timeoutMs: 8_000
      })
      void waiting.catch(() => {})
      setTimeout(() => {
        void Reflect.apply(
          Reflect.get(pane.runtime, 'serializeProviderTerminalBuffer'),
          pane.runtime,
          [TRANSCRIPT_PANE_PTY_ID, { scrollbackRows: 0 }]
        )
      }, 1_000)
      setTimeout(() => delayed.resolve(idle), 3_250)
      await vi.advanceTimersByTimeAsync(8_000)
      await expect(waiting).rejects.toThrow('timeout')
      expect(pane.serializeProviderBuffer).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves an unknown current foreground pending', async () => {
    const pane = await restoredCodex(readRuntimeFixture('codex-0-158-0-timed-turn'))
    pane.confirmForegroundProcess.mockResolvedValue('vim')
    await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
  })

  it('leaves an unavailable provider view pending', async () => {
    const pane = await restoredCodex(readRuntimeFixture('codex-0-158-0-timed-turn'))
    pane.serializeProviderBuffer.mockRejectedValue(new Error('host unavailable'))
    await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
    expect(pane.pty.connected).toBe(true)
  })

  it.each(['incarnation', 'provider'] as const)(
    'refuses a provider frame after the %s identity was replaced',
    async (replacement) => {
      const pane = await restoredCodex(readRuntimeFixture('codex-0-158-0-timed-turn'))
      const original = pane.serializeProviderBuffer.getMockImplementation()!
      pane.serializeProviderBuffer.mockImplementation(async () => {
        const snapshot = await original()
        if (replacement === 'incarnation') {
          pane.pty.incarnationId = 'inc-2'
        } else {
          pane.runtime.setPtyController({ ...pane.controller })
        }
        return snapshot
      })
      await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
    }
  )

  it('refuses a provider frame from a retired lifecycle generation', async () => {
    const pane = await restoredCodex(readRuntimeFixture('codex-0-158-0-timed-turn'))
    const original = pane.serializeProviderBuffer.getMockImplementation()!
    pane.serializeProviderBuffer.mockImplementation(async () => {
      const snapshot = await original()
      Reflect.apply(Reflect.get(pane.runtime, 'advancePtyLifecycleGeneration'), pane.runtime, [
        TRANSCRIPT_PANE_PTY_ID
      ])
      return snapshot
    })
    await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
  })
})

describe('restored headless agent foreground confirmation', () => {
  async function pane() {
    return createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: '2.1.258',
      headless: true,
      data: ''
    })
  }

  it('recognizes native Claude through the owning provider fresh command', async () => {
    const created = await pane()
    const confirmForegroundProcess = vi.fn(async () => '/opt/claude/2.1.258/claude')
    created.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => '2.1.258',
      confirmForegroundProcess
    })
    await expect(created.runtime.isTerminalRunningAgent(created.handle)).resolves.toBe(true)
    expect(confirmForegroundProcess).toHaveBeenCalledWith(TRANSCRIPT_PANE_PTY_ID)
    expect(Reflect.get(created.runtime, 'ptysById').get(TRANSCRIPT_PANE_PTY_ID).foregroundAgent).toBe(
      'claude'
    )
  })

  it.each([null, 'vim'])('keeps unrecognized provider evidence %s unrecognized', async (foreground) => {
    const created = await pane()
    created.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => '2.1.258',
      confirmForegroundProcess: async () => foreground
    })
    await expect(created.runtime.isTerminalRunningAgent(created.handle)).resolves.toBe(false)
    expect((await created.runtime.showTerminal(created.handle)).connected).toBe(true)
  })

  it.each(['incarnation', 'provider', 'generation'] as const)(
    'refuses fresh foreground evidence after %s replacement',
    async (replacement) => {
      const created = await pane()
      const deferred = Promise.withResolvers<string | null>()
      const confirmForegroundProcess = vi.fn(() => deferred.promise)
      const controller = {
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => '2.1.258',
        confirmForegroundProcess
      }
      created.runtime.setPtyController(controller)
      const running = created.runtime.isTerminalRunningAgent(created.handle)
      await vi.waitFor(() => expect(confirmForegroundProcess).toHaveBeenCalledOnce())
      if (replacement === 'incarnation') {
        Reflect.get(created.runtime, 'ptysById').get(TRANSCRIPT_PANE_PTY_ID).incarnationId = 'inc-2'
      } else if (replacement === 'provider') {
        created.runtime.setPtyController({ ...controller })
      } else {
        Reflect.apply(Reflect.get(created.runtime, 'advancePtyLifecycleGeneration'), created.runtime, [
          TRANSCRIPT_PANE_PTY_ID
        ])
      }
      deferred.resolve('claude')
      await expect(running).resolves.toBe(false)
    }
  )
})
