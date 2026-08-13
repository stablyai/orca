import { describe, expect, it, vi } from 'vitest'

import {
  UPDATER_INSTALL_COMMITTED_CHANNEL,
  UPDATER_IS_INSTALL_COMMITTED_SYNC_CHANNEL
} from '../shared/updater-install-events'
import {
  createInstallCommitmentReader,
  type InstallCommitmentIpc
} from './updater-install-commitment-bridge'

type Listener = (event: unknown, committed: boolean) => void

function fakeIpc(options: {
  sample?: boolean | (() => never)
  onSubscribe?: (emit: (committed: boolean) => void) => void
}): { ipc: InstallCommitmentIpc & { on: ReturnType<typeof vi.fn>; sendSync: ReturnType<typeof vi.fn> }; emit: (c: boolean) => void } {
  let listener: Listener | null = null
  const emit = (committed: boolean): void => listener?.(null, committed)
  const on = vi.fn((channel: string, l: Listener) => {
    if (channel === UPDATER_INSTALL_COMMITTED_CHANNEL) {
      listener = l
    }
  })
  const sendSync = vi.fn((_channel: string) => {
    // Lets a test deliver a broadcast while the synchronous sample is in flight.
    options.onSubscribe?.(emit)
    if (typeof options.sample === 'function') {
      return options.sample()
    }
    return options.sample ?? false
  })
  return { ipc: { on, sendSync }, emit }
}

describe('preload install commitment bridge', () => {
  it('reports an install that was already committed when the document loaded', () => {
    // A document created or reloaded mid-install: its first lazy import must know.
    const { ipc } = fakeIpc({ sample: true })

    expect(createInstallCommitmentReader(ipc)()).toBe(true)
    expect(ipc.sendSync).toHaveBeenCalledWith(UPDATER_IS_INSTALL_COMMITTED_SYNC_CHANNEL)
  })

  it('subscribes before sampling, so a broadcast in flight is not overwritten', () => {
    // Main commits between this document subscribing and its sample returning. The
    // older `false` the sample carries must not win.
    const { ipc } = fakeIpc({ sample: false, onSubscribe: (emit) => emit(true) })

    expect(createInstallCommitmentReader(ipc)()).toBe(true)
  })

  it('is a live read, so a commitment landing later is still seen', () => {
    const { ipc, emit } = fakeIpc({ sample: false })
    const read = createInstallCommitmentReader(ipc)
    expect(read()).toBe(false)

    emit(true)

    expect(read()).toBe(true)
  })

  it('stands down when main does', () => {
    const { ipc, emit } = fakeIpc({ sample: true })
    const read = createInstallCommitmentReader(ipc)

    emit(false)

    expect(read()).toBe(false)
  })

  it('subscribes to the same channel main broadcasts on', () => {
    // A drifted channel name would silently disable every renderer's protection.
    const { ipc } = fakeIpc({ sample: false })

    createInstallCommitmentReader(ipc)

    expect(ipc.on).toHaveBeenCalledWith(UPDATER_INSTALL_COMMITTED_CHANNEL, expect.any(Function))
  })

  it('treats an unanswered probe as no install, never as one', () => {
    // Claiming an install here would disable ordinary chunk recovery for the life of
    // the document, which is far worse than the reload this PR suppresses.
    const { ipc } = fakeIpc({
      sample: () => {
        throw new Error('no handler registered')
      }
    })

    expect(createInstallCommitmentReader(ipc)()).toBe(false)
  })
})
