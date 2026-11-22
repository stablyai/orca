import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PairedServerAgentRowsChanges } from '../sidebar-inputs/workspace-rows/paired-server-rows-watch'
import type { DescribedRelayHost } from './mobile-relay-host-descriptions'
import { RelayHostRowsAnnouncer } from './mobile-relay-host-rows-announcer'

const host: DescribedRelayHost = {
  hostId: 'runtime:env-1',
  label: 'Build box',
  health: 'available',
  relay: 'ready',
  environmentId: 'env-1',
  identity: { pairingRevision: 1, runtimeId: 'rt-1' }
}

function reader(connectionId: string) {
  const releases: (() => void)[] = []
  return {
    releases,
    reader: { connectionId, onClose: (release: () => void) => releases.push(release) }
  }
}

describe('RelayHostRowsAnnouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("forwards a burst of a read server's row notices to phones as one coalesced change", async () => {
    const source = new PairedServerAgentRowsChanges()
    const changed = vi.fn()
    const announcer = new RelayHostRowsAnnouncer(source, changed)
    source.emit('env-1')
    await vi.advanceTimersByTimeAsync(2000)
    // No phone has read this server yet.
    expect(changed).not.toHaveBeenCalled()

    announcer.hold(host, reader('phone-1').reader)
    source.emit('env-1')
    source.emit('env-1')
    source.emit('env-2')
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith('runtime:env-1')
  })

  it('announces a server until the last phone connection that read it closes', async () => {
    const source = new PairedServerAgentRowsChanges()
    const changed = vi.fn()
    const announcer = new RelayHostRowsAnnouncer(source, changed)
    const first = reader('phone-1')
    const second = reader('phone-2')
    announcer.hold(host, first.reader)
    announcer.hold(host, first.reader)
    announcer.hold(host, second.reader)
    // A connection that reads again holds no second release.
    expect(first.releases).toHaveLength(1)

    first.releases[0]?.()
    source.emit('env-1')
    await vi.advanceTimersByTimeAsync(500)
    expect(changed).toHaveBeenCalledTimes(1)

    second.releases[0]?.()
    source.emit('env-1')
    await vi.advanceTimersByTimeAsync(2000)
    expect(changed).toHaveBeenCalledTimes(1)

    announcer.dispose()
    announcer.hold(host, reader('phone-3').reader)
    source.emit('env-1')
    await vi.advanceTimersByTimeAsync(2000)
    expect(changed).toHaveBeenCalledTimes(1)
  })
})
