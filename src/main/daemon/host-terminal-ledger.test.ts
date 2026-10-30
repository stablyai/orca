import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MAX_HOST_TERMINALS,
  defaultHostTerminalLedgerDir,
  HostTerminalLedger,
  resolveMaxHostTerminals
} from './host-terminal-ledger'

const share = (terminals: number) => ({
  terminals,
  automaticInFlight: 0,
  automaticLive: 0,
  automaticAdmits: []
})

const createDir = (path: string): void => {
  mkdirSync(path, { recursive: true })
}

describe('HostTerminalLedger', () => {
  let dir: string
  let alive: Set<number>
  let now: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-host-terminals-'))
    alive = new Set([100, 200])
    now = 1_000_000
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function ledger(pid: number, maxTerminals = 4): HostTerminalLedger {
    return new HostTerminalLedger({
      dir,
      maxTerminals,
      pid,
      now: () => now,
      isProcessAlive: (candidate) => alive.has(candidate),
      // Inject creation because the production guard rejects shared parents such as /tmp.
      createDir,
      log: vi.fn()
    })
  }

  it('shares one cap between two daemons on the same host', () => {
    const desktop = ledger(100)
    const serve = ledger(200)
    expect(desktop.tryReserve(share(0))).toBe(true)
    expect(desktop.tryReserve(share(1))).toBe(true)
    expect(serve.tryReserve(share(0))).toBe(true)
    expect(serve.tryReserve(share(1))).toBe(true)

    expect(desktop.tryReserve(share(2))).toBe(false)
    expect(serve.tryReserve(share(2))).toBe(false)

    serve.publish(share(1))
    expect(desktop.tryReserve(share(2))).toBe(true)
  })

  it('leaves its published count unchanged when a reservation does not fit', () => {
    const desktop = ledger(100)
    const serve = ledger(200)
    desktop.publish(share(4))
    expect(serve.tryReserve(share(0))).toBe(false)
    desktop.publish(share(3))
    expect(desktop.tryReserve(share(3))).toBe(true)
  })

  it('ignores and removes the entry of a daemon that died without cleaning up', () => {
    const crashed = ledger(200)
    crashed.publish(share(4))
    alive.delete(200)
    expect(ledger(100).tryReserve(share(0))).toBe(true)
    expect(readdirSync(dir)).toEqual(['100.json'])
  })

  it('ignores an entry whose owner stopped refreshing it', () => {
    ledger(200).publish(share(4))
    now += 6 * 60_000
    expect(ledger(100).tryReserve(share(0))).toBe(true)
  })

  it('keeps an idle daemon counted by refreshing its entry', () => {
    vi.useFakeTimers({ now })
    try {
      const idle = new HostTerminalLedger({
        dir,
        maxTerminals: 4,
        pid: 200,
        isProcessAlive: (candidate) => alive.has(candidate),
        createDir,
        log: vi.fn()
      })
      idle.publish(share(4))
      idle.start()
      vi.advanceTimersByTime(10 * 60_000)
      now = Date.now()
      expect(ledger(100).tryReserve(share(0))).toBe(false)
      idle.close()
      expect(ledger(100).tryReserve(share(0))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('recreates its directory when a cleaner removed it', () => {
    const desktop = ledger(100)
    desktop.publish(share(1))
    rmSync(dir, { recursive: true, force: true })
    desktop.publish(share(4))
    expect(ledger(200).tryReserve(share(0))).toBe(false)
  })

  it('sums the automatic work other daemons publish, and forgets old admits', () => {
    ledger(200).publish({
      terminals: 3,
      automaticInFlight: 1,
      automaticLive: 2,
      automaticAdmits: [now - 60_000, now - 100]
    })
    ledger(300).publish(share(1))
    alive.add(300)
    expect(ledger(100).readOthers()).toEqual({
      terminals: 4,
      automatic: { inFlight: 1, live: 2, admits: [now - 100] }
    })
  })

  it('reads an entry from a daemon that publishes terminals only', () => {
    writeFileSync(
      join(dir, '200.json'),
      JSON.stringify({ schemaVersion: 1, pid: 200, terminals: 2, updatedAt: now })
    )
    expect(ledger(100).readOthers()).toEqual({
      terminals: 2,
      automatic: { inFlight: 0, live: 0, admits: [] }
    })
  })

  it('skips an unreadable entry instead of blocking terminals', () => {
    writeFileSync(join(dir, '200.json'), 'not json')
    expect(ledger(100, 1).tryReserve(share(0))).toBe(true)
  })

  it('still caps its own terminals when the shared directory is unavailable', () => {
    const log = vi.fn()
    const isolated = new HostTerminalLedger({
      dir: join(dir, 'missing', 'nested'),
      maxTerminals: 2,
      pid: 100,
      createDir: () => {
        throw new Error('EACCES')
      },
      log
    })
    expect(isolated.tryReserve(share(1))).toBe(true)
    expect(isolated.tryReserve(share(2))).toBe(false)
    expect(log).toHaveBeenCalledWith('host-terminal-ledger-unavailable', expect.any(Object))
  })

  it('counts only itself without a shared directory', () => {
    const solo = new HostTerminalLedger({ dir: null, maxTerminals: 1, pid: 100, log: vi.fn() })
    expect(solo.tryReserve(share(0))).toBe(true)
    expect(solo.tryReserve(share(1))).toBe(false)
  })
})

describe('resolveMaxHostTerminals', () => {
  it('defaults when the override is absent or out of range', () => {
    expect(resolveMaxHostTerminals({})).toBe(DEFAULT_MAX_HOST_TERMINALS)
    expect(resolveMaxHostTerminals({ ORCA_DAEMON_MAX_HOST_TERMINALS: 'many' })).toBe(
      DEFAULT_MAX_HOST_TERMINALS
    )
    expect(resolveMaxHostTerminals({ ORCA_DAEMON_MAX_HOST_TERMINALS: '0' })).toBe(
      DEFAULT_MAX_HOST_TERMINALS
    )
    expect(resolveMaxHostTerminals({ ORCA_DAEMON_MAX_HOST_TERMINALS: '100000' })).toBe(
      DEFAULT_MAX_HOST_TERMINALS
    )
  })

  it('accepts a tuned cap', () => {
    expect(resolveMaxHostTerminals({ ORCA_DAEMON_MAX_HOST_TERMINALS: ' 64 ' })).toBe(64)
  })
})

describe('defaultHostTerminalLedgerDir', () => {
  it('uses the per-user machine-local base beside relocated daemon sockets', () => {
    expect(defaultHostTerminalLedgerDir('linux', 1000)).toBe('/tmp/.orca-daemon-1000/terminals')
    expect(defaultHostTerminalLedgerDir('darwin', 501)).toBe('/tmp/.orca-daemon-501/terminals')
    expect(defaultHostTerminalLedgerDir('win32', undefined)).toBe(
      join(tmpdir(), 'orca-daemon-host-terminals')
    )
  })
})
