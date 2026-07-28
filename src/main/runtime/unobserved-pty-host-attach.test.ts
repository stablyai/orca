/** A daemon session can outlive the host app with its shell alive but nothing attached: output reaches
 *  only the daemon and remote keystrokes land in a terminal no client can see. Subscribe must re-attach. */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

type RuntimeInternals = {
  handles: Map<string, unknown>
  ptysById: Map<string, { ptyId: string; lastOutputAt: number | null }>
  headlessTerminals: Map<string, unknown>
  getAuthoritativeWindow: () => {
    webContents: { send: (channel: string, payload: unknown) => void }
  }
}

function seedRuntime(options: { lastOutputAt?: number | null; withWindow?: boolean } = {}): {
  runtime: OrcaRuntimeService
  send: ReturnType<typeof vi.fn>
  internals: RuntimeInternals
} {
  const runtime = new OrcaRuntimeService()
  const internals = runtime as unknown as RuntimeInternals
  internals.handles.set('term_1', {
    handle: 'term_1',
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    ptyGeneration: 1,
    runtimeId: 'rt-test',
    rendererGraphEpoch: 1
  })
  internals.ptysById.set('pty-1', {
    ptyId: 'pty-1',
    lastOutputAt: options.lastOutputAt ?? null
  })
  const send = vi.fn()
  internals.getAuthoritativeWindow =
    options.withWindow === false
      ? () => {
          throw new Error('no authoritative window')
        }
      : () => ({ webContents: { send } })
  return { runtime, send, internals }
}

describe('host attach for unobserved PTYs', () => {
  it('requests a host pane mount when the runtime has never seen output', () => {
    const { runtime, send } = seedRuntime()

    expect(runtime.requestHostPaneAttachForUnobservedPty('term_1', 'pty-1')).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('terminal:requestTabMount', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      ptyId: 'pty-1'
    })
  })

  it('requests the mount only once while the attach is still pending', () => {
    const { runtime, send } = seedRuntime()

    expect(runtime.requestHostPaneAttachForUnobservedPty('term_1', 'pty-1')).toBe(true)
    expect(runtime.requestHostPaneAttachForUnobservedPty('term_1', 'pty-1')).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('leaves a pane alone once its output pipeline has proven itself', () => {
    const { runtime, send } = seedRuntime({ lastOutputAt: Date.now() })

    expect(runtime.requestHostPaneAttachForUnobservedPty('term_1', 'pty-1')).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('leaves a pane alone when main already holds headless terminal state', () => {
    const { runtime, send, internals } = seedRuntime()
    internals.headlessTerminals.set('pty-1', {})

    expect(runtime.requestHostPaneAttachForUnobservedPty('term_1', 'pty-1')).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('leaves a pane alone when a renderer serializer is already attached', () => {
    const { runtime, send } = seedRuntime()
    runtime.setPtyController({
      hasRendererSerializer: () => true
    } as unknown as Parameters<OrcaRuntimeService['setPtyController']>[0])

    expect(runtime.requestHostPaneAttachForUnobservedPty('term_1', 'pty-1')).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('ignores an unknown PTY record', () => {
    const { runtime, send } = seedRuntime()

    expect(runtime.requestHostPaneAttachForUnobservedPty('term_1', 'pty-missing')).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  // Why: a headless host has no window to mount into, so the request must stay retryable.
  it('does not consume the single-flight when no window can take the mount', () => {
    const { runtime, internals } = seedRuntime({ withWindow: false })

    expect(runtime.requestHostPaneAttachForUnobservedPty('term_1', 'pty-1')).toBe(false)

    const send = vi.fn()
    internals.getAuthoritativeWindow = () => ({ webContents: { send } })
    expect(runtime.requestHostPaneAttachForUnobservedPty('term_1', 'pty-1')).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
