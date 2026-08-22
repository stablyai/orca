import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  applySshReattachReplayModelCatchUp,
  capturePtyModelIngestFence
} from './ssh-reattach-replay-model-catchup'

const catchUpRuntime = (): {
  hasHeadlessTerminal: (ptyId: string) => boolean
  appendHeadlessTerminalCatchUp: Mock<(ptyId: string, data: string, fence: number) => boolean>
} => ({
  hasHeadlessTerminal: () => true,
  appendHeadlessTerminalCatchUp: vi.fn((_ptyId: string, _data: string, _fence: number) => true)
})

const attachArgs = (
  runtime: ReturnType<typeof catchUpRuntime>,
  fence: ReturnType<typeof capturePtyModelIngestFence>
): Parameters<typeof applySshReattachReplayModelCatchUp>[0] => ({
  runtime,
  ptyId: 'ssh:host-a@@pty-1',
  isReattach: true,
  replay: 'BEFORE|DURING',
  replayUnseenChars: 'DURING'.length,
  seededFromReplay: false,
  modelIngestFence: fence
})

describe('applySshReattachReplayModelCatchUp', () => {
  it('ingests the withheld tail once per attach, even when adopters share it', () => {
    // Deduped stable-pane adoptions hand one attach result to several callers; the second must not
    // re-append the tail the first already ingested.
    const runtime = catchUpRuntime()
    const fence = capturePtyModelIngestFence(
      { getPtyOutputSequence: () => 12 },
      'ssh:host-a@@pty-1'
    )

    expect(applySshReattachReplayModelCatchUp(attachArgs(runtime, fence))).toBe(true)
    expect(applySshReattachReplayModelCatchUp(attachArgs(runtime, fence))).toBe(false)
    expect(runtime.appendHeadlessTerminalCatchUp).toHaveBeenCalledTimes(1)
    expect(runtime.appendHeadlessTerminalCatchUp).toHaveBeenCalledWith(
      'ssh:host-a@@pty-1',
      'DURING',
      12
    )
  })

  it('refuses a fence minted for a different pty', () => {
    // A fresh spawn after a failed adoption returns a different id; that attach never withheld this
    // tail, so its fence proves nothing about this model.
    const runtime = catchUpRuntime()
    const fence = capturePtyModelIngestFence({ getPtyOutputSequence: () => 4 }, 'ssh:host-a@@pty-9')

    expect(applySshReattachReplayModelCatchUp(attachArgs(runtime, fence))).toBe(false)
    expect(runtime.appendHeadlessTerminalCatchUp).not.toHaveBeenCalled()
  })

  it('refuses when no fence was minted beside the attach', () => {
    const runtime = catchUpRuntime()

    expect(applySshReattachReplayModelCatchUp(attachArgs(runtime, null))).toBe(false)
    expect(runtime.appendHeadlessTerminalCatchUp).not.toHaveBeenCalled()
  })
})

describe('capturePtyModelIngestFence', () => {
  it('refuses to invent a sequence a runtime cannot report', () => {
    // Reading absence as 0 would let the very first live byte pass the fence check.
    expect(capturePtyModelIngestFence({}, 'ssh:host-a@@pty-1')).toBeNull()
    expect(capturePtyModelIngestFence(undefined, 'ssh:host-a@@pty-1')).toBeNull()
    expect(capturePtyModelIngestFence({ getPtyOutputSequence: () => 0 }, undefined)).toBeNull()
    expect(
      capturePtyModelIngestFence({ getPtyOutputSequence: () => 0 }, 'ssh:host-a@@pty-1')
    ).toEqual({ ptyId: 'ssh:host-a@@pty-1', sequence: 0 })
  })
})
