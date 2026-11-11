import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ingestSyntheticTitleFrame } = vi.hoisted(() => ({
  ingestSyntheticTitleFrame: vi.fn((_ptyId: string, _data: string) => {})
}))

vi.mock('../ipc/pty/pane/key-state', () => ({
  registerPaneKeyTeardownListener: vi.fn(),
  getPtyIdForPaneKey: (paneKey: string) => `pty:${paneKey}`
}))
vi.mock('../agent-hooks/server/agent-hook-server', () => ({ agentHookServer: {} }))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    mainWindow: null,
    store: null,
    runtime: { ingestSyntheticTitleFrame, getTrackedPtyTitle: () => null }
  }
}))

import {
  driveSyntheticTitleFromHookStatus,
  stopSyntheticTitleSpinner
} from './synthetic-title-runtime'

const PANE = 'tab-1:leaf-1'
const QUESTION = JSON.stringify({ questions: [{ title: 'Which database?' }] })

function codexStatus(
  state: 'working' | 'waiting' | 'done',
  interactivePrompt?: string,
  toolName = 'request_user_input_async'
) {
  driveSyntheticTitleFromHookStatus({
    paneKey: PANE,
    payload: {
      state,
      agentType: 'codex',
      ...(interactivePrompt ? { toolName, interactivePrompt } : {})
    }
  })
}

// Codex's PermissionRequest hook carries no request id; two approvals can look identical.
const APPROVAL = JSON.stringify({ approval: { command: 'pnpm tc' } })

function bellCount(): number {
  return ingestSyntheticTitleFrame.mock.calls.filter(([, data]) => data.endsWith('\x07\x07')).length
}

describe('synthetic title BEL', () => {
  beforeEach(() => {
    ingestSyntheticTitleFrame.mockClear()
    stopSyntheticTitleSpinner(PANE)
  })

  it('rings once while hooks keep restating the same open question', () => {
    // Codex restates waiting on every tool call while its async question stays open.
    for (let i = 0; i < 20; i += 1) {
      codexStatus('waiting', QUESTION)
    }
    expect(bellCount()).toBe(1)
    // The permission title is still reasserted, only without a bell.
    expect(ingestSyntheticTitleFrame).toHaveBeenCalledTimes(20)
  })

  it('rings again for a new prompt and after the wait ends', () => {
    codexStatus('waiting', QUESTION)
    codexStatus('waiting', JSON.stringify({ questions: [{ title: 'Which table name?' }] }))
    codexStatus('waiting', QUESTION)
    expect(bellCount()).toBe(2)

    codexStatus('done')
    codexStatus('waiting', QUESTION)
    expect(bellCount()).toBe(3)

    codexStatus('working')
    codexStatus('waiting', QUESTION)
    expect(bellCount()).toBe(4)
  })
  it('rings for each approval during an open question, but not for the question again', () => {
    codexStatus('waiting', QUESTION)
    codexStatus('waiting', APPROVAL, 'Bash')
    // Approved: Codex keeps working and restates the still-open question.
    codexStatus('waiting', QUESTION)
    codexStatus('waiting', APPROVAL, 'Bash')
    expect(bellCount()).toBe(3)
  })
})

describe('Cursor synthetic titles', () => {
  beforeEach(() => {
    ingestSyntheticTitleFrame.mockClear()
    stopSyntheticTitleSpinner(PANE)
  })

  it('leaves the working title to cursor-agent and still writes the ready title', () => {
    // cursor-agent animates `<chat> - ⏳ Working` itself; a frame per tool hook made the tab flicker (STA-14266).
    for (let i = 0; i < 3; i += 1) {
      driveSyntheticTitleFromHookStatus({
        paneKey: PANE,
        payload: { state: 'working', agentType: 'cursor', toolName: 'Shell' }
      })
    }
    expect(ingestSyntheticTitleFrame).not.toHaveBeenCalled()

    driveSyntheticTitleFromHookStatus({
      paneKey: PANE,
      payload: { state: 'done', agentType: 'cursor' }
    })
    expect(ingestSyntheticTitleFrame).toHaveBeenCalledWith(`pty:${PANE}`, '\x1b]0;Cursor ready\x07')
  })
})
