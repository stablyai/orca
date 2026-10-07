import { expect, it } from 'vitest'
import { setTerminalViewAttributes } from './terminal-view-attribute-store'
import {
  CHECKPOINT_THEME,
  captureRuntime,
  createCheckpointRuntime
} from './headless-model-checkpoint-test-fixture'
import { PTY_ID } from './headless-hydration-ownership-test-fixture'

it('preserves per-model color overrides and their reset base across publication', async () => {
  setTerminalViewAttributes(CHECKPOINT_THEME)
  const runtime = createCheckpointRuntime()
  runtime.onPtyData(PTY_ID, '\x1b]4;7;#ff0000\x07\x1b]10;#00ff00\x07', 1)
  const capture = await captureRuntime(runtime)
  const query = '\x1b]4;7;?\x07\x1b]10;?\x07'
  try {
    await runtime.model().emulator.write(query, { forwardQueryReplies: true })
    const expected = runtime.replies.mock.calls.map((call) => [...call])
    runtime.replies.mockClear()
    await runtime.restoreHeadlessTerminalModelCheckpoint(PTY_ID, capture)
    await runtime.model().emulator.write(query, { forwardQueryReplies: true })
    expect(runtime.replies.mock.calls).toEqual(expected)
    runtime.replies.mockClear()
    runtime.onPtyData(PTY_ID, '\x1b]104;7\x07\x1b]110\x07', 2)
    await runtime.model().writeChain
    await runtime.model().emulator.write(query, { forwardQueryReplies: true })
    expect(runtime.replies).toHaveBeenCalledWith(
      PTY_ID,
      '\x1b]4;7;rgb:1414/1414/1414\x1b\\',
      'query-reply'
    )
    expect(runtime.replies).toHaveBeenCalledWith(
      PTY_ID,
      '\x1b]10;rgb:c8c8/c8c8/c8c8\x1b\\',
      'query-reply'
    )
  } finally {
    capture.dispose()
  }
})

it('rejects publication if the shared theme changes after capture', async () => {
  setTerminalViewAttributes(CHECKPOINT_THEME)
  const runtime = createCheckpointRuntime()
  runtime.onPtyData(PTY_ID, 'BEFORE', 1)
  const capture = await captureRuntime(runtime)
  const original = runtime.model().emulator
  try {
    setTerminalViewAttributes({ ...CHECKPOINT_THEME, background: [0, 0, 255] })
    await expect(runtime.restoreHeadlessTerminalModelCheckpoint(PTY_ID, capture)).rejects.toThrow(
      /changed/
    )
    expect(runtime.model().emulator).toBe(original)
  } finally {
    capture.dispose()
  }
})
