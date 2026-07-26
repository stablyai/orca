import { describe, expect, it, vi } from 'vitest'
import {
  createDaemonLostWorkerSnapshotSource,
  createRelayLostWorkerSnapshotSource
} from './terminal-lost-worker-snapshot-source'

const pane = (archivedLeafId: string) => ({ archivedLeafId, cwd: '/worktree' })

const captured = (source: 'daemon-headless' | 'relay-tail' | 'session-sidecar') => ({
  kind: 'captured-bytes' as const,
  buffer: source,
  source,
  truncated: false,
  byteLength: source.length
})

describe('lost-worker snapshot source', () => {
  it('uses a staged relay tail only when a session sidecar is unavailable', async () => {
    const sidecar = vi.fn().mockReturnValue(undefined)
    const relayTail = vi.fn().mockReturnValue(captured('relay-tail'))
    const source = createRelayLostWorkerSnapshotSource({
      captureSessionSidecar: sidecar,
      captureRelayTail: relayTail
    })

    await expect(source.capture(pane('sibling'))).resolves.toMatchObject({ source: 'relay-tail' })
    expect(sidecar).toHaveBeenCalledWith('sibling')
    expect(relayTail).toHaveBeenCalledWith('sibling')
  })

  it('uses a daemon sibling probe only after its sidecar is unavailable', async () => {
    const sidecar = vi.fn().mockReturnValue(undefined)
    const siblingProbe = vi.fn().mockReturnValue(captured('daemon-headless'))
    const source = createDaemonLostWorkerSnapshotSource({
      lostLeafId: 'lost',
      captureLostLeaf: () => captured('daemon-headless'),
      captureSessionSidecar: sidecar,
      captureSiblingColdRestore: siblingProbe
    })

    await expect(source.capture(pane('sibling'))).resolves.toMatchObject({
      source: 'daemon-headless'
    })
    expect(sidecar).toHaveBeenCalledWith('sibling')
    expect(siblingProbe).toHaveBeenCalledWith('sibling')
  })

  it('never probes a sibling for the original lost leaf', async () => {
    const siblingProbe = vi.fn().mockReturnValue(captured('daemon-headless'))
    const source = createDaemonLostWorkerSnapshotSource({
      lostLeafId: 'lost',
      captureLostLeaf: () => captured('daemon-headless'),
      captureSessionSidecar: () => undefined,
      captureSiblingColdRestore: siblingProbe
    })

    await expect(source.capture(pane('lost'))).resolves.toMatchObject({ source: 'daemon-headless' })
    expect(siblingProbe).not.toHaveBeenCalled()
  })
})
