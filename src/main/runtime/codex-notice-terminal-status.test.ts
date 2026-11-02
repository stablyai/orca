import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import {
  CODEX_CAPACITY_MESSAGE,
  createCodexCapacityNoticeTracker
} from '../../shared/codex-native-notice'
import { observeCodexCapacityTerminalStatus } from './codex-notice-terminal-status'
import * as agentProcessRecognition from '../../shared/agent-process-recognition'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'

const transcript = readFileSync(
  new URL('./__fixtures__/codex-model-capacity.txt', import.meta.url),
  'utf8'
)
const fullscreenTranscript = readFileSync(
  new URL('./__fixtures__/codex-model-capacity-fullscreen.txt', import.meta.url),
  'utf8'
)

describe('Codex model capacity terminal status', () => {
  it.each([
    [transcript, 80, 1],
    [transcript, 80, 7],
    [transcript, 80, 64],
    [transcript, 80, 8192],
    [fullscreenTranscript, 40, 1],
    [fullscreenTranscript, 40, 7],
    [fullscreenTranscript, 40, 64],
    [fullscreenTranscript, 40, 8192]
  ] as const)('reads a captured notice %#', async (recording, cols, size) => {
    const emulator = new HeadlessEmulator({ cols, rows: 24 })
    const tracker = createCodexCapacityNoticeTracker()
    let detected = false
    try {
      for (let index = 0; index < recording.length; index += size) {
        const chunk = recording.slice(index, index + size)
        await emulator.write(chunk)
        detected ||= tracker.observe(chunk, () => emulator.getVisibleLines())
      }
      expect(detected).toBe(true)
    } finally {
      emulator.dispose()
    }
  })

  it('does not read the screen for ordinary output or OSC string payloads', () => {
    const tracker = createCodexCapacityNoticeTracker()
    const readScreen = vi.fn(() => [`■ ${CODEX_CAPACITY_MESSAGE}`, '›'])
    tracker.observe('x'.repeat(1_000_000), readScreen)
    tracker.observe(`\x1b]0;■ ${CODEX_CAPACITY_MESSAGE}\x07`, readScreen)
    expect(readScreen).not.toHaveBeenCalled()
  })

  it('ignores prose, old history before a new prompt, and a busy turn', () => {
    for (const lines of [
      [`• The error says: ■ ${CODEX_CAPACITY_MESSAGE}`, '›'],
      [`■ ${CODEX_CAPACITY_MESSAGE}`, '› continue', '• Working (1s • esc to interrupt)', '›'],
      [`■ ${CODEX_CAPACITY_MESSAGE}`, '• Working (1s • esc to interrupt)', '›']
    ]) {
      const tracker = createCodexCapacityNoticeTracker()
      expect(tracker.observe(`■ ${CODEX_CAPACITY_MESSAGE}`, () => lines)).toBe(false)
    }
  })

  it('handles a wrapped native warning and waits for the synchronized frame to finish', () => {
    const tracker = createCodexCapacityNoticeTracker()
    const screen = vi.fn(() => [
      '⚠ Selected model is at capacity. Please',
      '  try a different model.',
      '',
      '›'
    ])
    expect(
      tracker.observe(
        '\x1b[?2026h⚠ Selected model is at\ncapacity. Please\ntry a different model.',
        screen
      )
    ).toBe(false)
    expect(screen).not.toHaveBeenCalled()
    expect(tracker.observe('\x1b[?2026l', screen)).toBe(true)
  })

  it('publishes a failed root through the execution-host terminal status path', async () => {
    const onTerminalAgentStatus = vi.fn()
    const { runtime } = await createTranscriptPane(
      {
        paneTitle: 'Codex',
        foregroundProcess: 'codex',
        launchAgent: 'codex',
        data: ''
      },
      { onTerminalAgentStatus }
    )
    try {
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, transcript, 1)
      await vi.waitFor(() =>
        expect(onTerminalAgentStatus).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: expect.objectContaining({
              state: 'done',
              agentType: 'codex',
              lastAssistantMessage: CODEX_CAPACITY_MESSAGE,
              mainAgent: expect.objectContaining({ state: 'done', outcome: 'failure' })
            })
          })
        )
      )
    } finally {
      await runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
    }
  })

  it('does not produce client-side status for an SSH-owned PTY', async () => {
    const onTerminalAgentStatus = vi.fn()
    const { runtime, handle } = await createTranscriptPane(
      {
        paneTitle: 'Codex',
        foregroundProcess: 'codex',
        launchAgent: 'codex',
        connectionId: 'ssh-host',
        data: ''
      },
      { onTerminalAgentStatus }
    )
    try {
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, transcript, 1)
      await runtime.readTerminal(handle)
      expect(onTerminalAgentStatus).not.toHaveBeenCalled()
    } finally {
      await runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
    }
  })

  it('ignores unrelated agents', async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    try {
      await emulator.write(transcript)
      expect(
        observeCodexCapacityTerminalStatus(
          emulator,
          transcript,
          'claude',
          'claude',
          () => undefined
        )
      ).toBeNull()
    } finally {
      emulator.dispose()
    }
  })

  it('detects Codex launched inside a shell from its hook identity and skips normal output', async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    const readStatus = vi.fn(() => ({ agentType: 'codex', prompt: 'Say hi', model: 'gpt-5' }))
    try {
      expect(
        observeCodexCapacityTerminalStatus(emulator, 'normal output', 'zsh', undefined, readStatus)
      ).toBeNull()
      expect(readStatus).not.toHaveBeenCalled()
      await emulator.write(transcript)
      expect(
        observeCodexCapacityTerminalStatus(emulator, transcript, 'zsh', undefined, readStatus)
      ).toMatchObject({
        prompt: 'Say hi',
        model: 'gpt-5',
        mainAgent: { state: 'done', outcome: 'failure' }
      })
    } finally {
      emulator.dispose()
    }
  })

  it.each([100, 101])(
    'does not close a hook turn starting at or after output time (%i)',
    async (turnStartedAt) => {
      const emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      try {
        await emulator.write(transcript)
        expect(
          observeCodexCapacityTerminalStatus(
            emulator,
            transcript,
            undefined,
            'codex',
            () => ({
              agentType: 'codex',
              prompt: 'Retry',
              turnStartedAt
            }),
            100
          )
        ).toBeNull()
      } finally {
        emulator.dispose()
      }
    }
  )

  it.each([1, 7, 64, 8192])(
    'detects a first shell-launched notice in %i-character chunks',
    async (size) => {
      const start = fullscreenTranscript.lastIndexOf(
        '\x1b[?2026h',
        fullscreenTranscript.indexOf('■ Selected model')
      )
      const end = fullscreenTranscript.indexOf('\x1b[?2026l', start) + '\x1b[?2026l'.length
      const emulator = new HeadlessEmulator({ cols: 40, rows: 24 })
      let detections = 0
      try {
        await emulator.write(fullscreenTranscript.slice(0, start))
        for (let index = start; index < end; index += size) {
          const chunk = fullscreenTranscript.slice(index, Math.min(index + size, end))
          await emulator.write(chunk)
          if (
            observeCodexCapacityTerminalStatus(emulator, chunk, 'zsh', undefined, () => ({
              agentType: 'codex',
              prompt: 'Say hi'
            }))
          ) {
            detections++
          }
        }
        expect(detections).toBe(1)
      } finally {
        emulator.dispose()
      }
    }
  )

  it('recognizes an unrelated launch once and invalidates when its command changes', () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
    const recognize = vi.spyOn(agentProcessRecognition, 'recognizeAgentProcessFromCommandLine')
    const readStatus = vi.fn(() => undefined)
    try {
      for (let index = 0; index < 1000; index++) {
        observeCodexCapacityTerminalStatus(
          emulator,
          'ordinary output',
          'zsh',
          undefined,
          readStatus
        )
      }
      expect(recognize).toHaveBeenCalledTimes(1)
      observeCodexCapacityTerminalStatus(emulator, 'ordinary output', 'bash', undefined, readStatus)
      expect(recognize).toHaveBeenCalledTimes(2)
      expect(readStatus).not.toHaveBeenCalled()
    } finally {
      recognize.mockRestore()
      emulator.dispose()
    }
  })
})
