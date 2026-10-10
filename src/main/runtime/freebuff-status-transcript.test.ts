import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const transcript = readFileSync(
  join(import.meta.dirname, '__fixtures__/freebuff-lifecycle.txt'),
  'utf8'
)

describe('Freebuff execution-host status', () => {
  it('publishes real running, question, and settled screens into the canonical store', async () => {
    const wiring = makeAgentStatusStoreWiring()
    const { runtime } = await createTranscriptPane(
      {
        data: '',
        paneTitle: 'Freebuff',
        foregroundProcess: 'freebuff',
        launchAgent: 'freebuff',
        size: { cols: 120, rows: 40 }
      },
      wiring.deps
    )
    const states: string[] = []
    const questions: string[] = []
    try {
      // oxlint-disable-next-line no-control-regex -- Terminal protocol delimiters contain ESC and BEL.
      for (const frame of transcript.split(/(?<=\x1b\[\?2026l)/)) {
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, frame, Date.now())
        await runtime.serializeMainTerminalBuffer(TRANSCRIPT_PANE_PTY_ID)
        const row = wiring.statusStore.getStatusSnapshot()[0]
        if (row && states.at(-1) !== row.state) {
          states.push(row.state)
        }
        if (row?.interactivePrompt) {
          questions.push(row.interactivePrompt)
        }
      }
      expect(states).toContain('working')
      expect(states).toContain('waiting')
      expect(states.at(-1)).toBe('done')
      expect(questions.join('\n')).toMatch(/blue|green/i)
    } finally {
      runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
    }
  })
  it.each([
    { name: 'login', cols: 100, rows: 32, input: 'Sign in to Freebuff' },
    { name: 'trust', cols: 120, rows: 40, input: 'Trust repository agent files? [y/N]' }
  ])('publishes captured $name startup as blocked', async ({ name, cols, rows, input }) => {
    const wiring = makeAgentStatusStoreWiring()
    const { runtime } = await createTranscriptPane(
      {
        data: '',
        paneTitle: 'Freebuff',
        foregroundProcess: 'freebuff',
        launchAgent: 'freebuff',
        size: { cols, rows }
      },
      wiring.deps
    )
    try {
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        readFileSync(join(import.meta.dirname, `__fixtures__/freebuff-${name}.txt`), 'utf8'),
        Date.now()
      )
      await runtime.serializeMainTerminalBuffer(TRANSCRIPT_PANE_PTY_ID)
      expect(wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({
        state: 'blocked',
        toolInput: input,
        agentType: 'freebuff'
      })
    } finally {
      runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
    }
  })

  it('clears startup blocks and starts a fresh session after an earlier completed turn', async () => {
    const wiring = makeAgentStatusStoreWiring()
    const { runtime } = await createTranscriptPane(
      {
        data: '',
        paneTitle: 'Freebuff',
        foregroundProcess: 'freebuff',
        launchAgent: 'freebuff',
        size: { cols: 120, rows: 40 }
      },
      wiring.deps
    )
    try {
      for (const name of ['trust', 'ready', 'lifecycle', 'ready']) {
        runtime.onPtyData(
          TRANSCRIPT_PANE_PTY_ID,
          readFileSync(join(import.meta.dirname, `__fixtures__/freebuff-${name}.txt`), 'utf8'),
          Date.now()
        )
        await runtime.serializeMainTerminalBuffer(TRANSCRIPT_PANE_PTY_ID)
        expect(wiring.statusStore.getStatusSnapshot()[0]?.state).toBe(
          name === 'trust' ? 'blocked' : 'done'
        )
        if (name === 'ready') {
          expect(wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({
            sessionBoundary: true,
            prompt: ''
          })
        }
        if (name === 'lifecycle') {
          expect(wiring.statusStore.getStatusSnapshot()[0]?.sessionBoundary).not.toBe(true)
        }
      }
      expect(wiring.statusStore.getStatusSnapshot()[0]?.toolInput).toBeUndefined()
    } finally {
      runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
    }
  })

  it('does not infer remote status from the client screen', async () => {
    const wiring = makeAgentStatusStoreWiring()
    const { runtime } = await createTranscriptPane(
      {
        data: '',
        paneTitle: 'Freebuff',
        foregroundProcess: 'freebuff',
        connectionId: 'ssh-test',
        size: { cols: 120, rows: 40 }
      },
      wiring.deps
    )
    try {
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, transcript, Date.now())
      await runtime.serializeMainTerminalBuffer(TRANSCRIPT_PANE_PTY_ID)
      expect(wiring.statusStore.getStatusSnapshot()).toEqual([])
    } finally {
      runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
    }
  })
})
