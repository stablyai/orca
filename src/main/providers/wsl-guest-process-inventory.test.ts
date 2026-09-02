import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: (...args: unknown[]) => runProcessMock(...args)
}))
import {
  createWslGuestProcessInventoryReader,
  parseWslGuestProcessInventoryPayload,
  readWslGuestProcessInventory,
  resetWslGuestProcessInventoryForTests,
  resolveWslGuestForegroundProcess,
  WSL_GUEST_INVENTORY_SCRIPT
} from './wsl-guest-process-inventory'

const bootId = '01234567-89ab-cdef-0123-456789abcdef'

function payload(rows: string, count = rows ? rows.split('\n').length : 0): string {
  return `boot ${bootId}\n${rows}${rows ? '\n' : ''}count ${count} ${count}\n`
}

describe('WSL guest process inventory', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
  })

  it('keeps the guest inventory script valid for /bin/sh', () => {
    expect(() => execFileSync('sh', ['-n'], { input: WSL_GUEST_INVENTORY_SCRIPT })).not.toThrow()
  })

  it('reads proc start times without forking cat per process', () => {
    expect(WSL_GUEST_INVENTORY_SCRIPT).toContain(
      'IFS= read -r _orca_procstat < "/proc/$_orca_pid/stat"'
    )
    expect(WSL_GUEST_INVENTORY_SCRIPT).not.toContain('cat "/proc/$_orca_pid/stat"')
  })

  it('skips a process whose proc stat disappears and keeps the remaining agent row', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'wsl-guest-inventory-'))
    try {
      mkdirSync(join(fixtureRoot, 'sys/kernel/random'), { recursive: true })
      writeFileSync(join(fixtureRoot, 'sys/kernel/random/boot_id'), `${bootId}\n`)
      mkdirSync(join(fixtureRoot, '100'))
      mkdirSync(join(fixtureRoot, '101'))
      // Linux /proc/<pid>/stat-shaped output: field 22 is the start-time tick.
      writeFileSync(
        join(fixtureRoot, '100/stat'),
        `100 (bash) S ${Array.from({ length: 18 }, () => '0').join(' ')} 12345 0\n`
      )
      writeFileSync(
        join(fixtureRoot, '101/stat'),
        `101 (codex) S ${Array.from({ length: 18 }, () => '0').join(' ')} 54321 0\n`
      )
      const binRoot = join(fixtureRoot, 'bin')
      mkdirSync(binRoot)
      const fakePs = join(binRoot, 'ps')
      writeFileSync(
        fakePs,
        '#!/bin/sh\nprintf "%s\\n" "999999 0 100 100 100 pts/0 S short-lived" "100 0 100 100 101 pts/0 Ss+ bash" "101 100 100 101 101 pts/0 Sl+ codex"\n'
      )
      chmodSync(fakePs, 0o755)
      const script = WSL_GUEST_INVENTORY_SCRIPT.replaceAll(
        '/proc',
        fixtureRoot.replaceAll('\\', '/')
      )
      const output = execFileSync('sh', ['-c', script], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${binRoot}:${process.env.PATH ?? ''}` }
      })
      expect(output).toContain('skip 999999')
      const inventory = parseWslGuestProcessInventoryPayload(output, 'Ubuntu')
      expect(inventory.rows).toHaveLength(2)
      const resolved = resolveWslGuestForegroundProcess(inventory, {
        distro: 'Ubuntu',
        bootId,
        shellPid: 100,
        shellStartTime: 12345,
        tty: '/dev/pts/0'
      })
      expect(resolved).toMatchObject({ status: 'live', processName: 'codex' })
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('parses fixed fields and preserves whitespace in args', () => {
    const inventory = parseWslGuestProcessInventoryPayload(
      payload('row 100 90 90 100 100 pts/0 Sl+ 12345 /usr/bin/node --name "a b" --x'),
      'Ubuntu'
    )
    expect(inventory.rows[0]).toMatchObject({
      pid: 100,
      ppid: 90,
      sid: 90,
      pgid: 100,
      tpgid: 100,
      tty: 'pts/0',
      stat: 'Sl+',
      startTimeTicks: 12345,
      command: '/usr/bin/node --name "a b" --x'
    })
  })

  it('keeps trailing spaces in the command remainder', () => {
    const inventory = parseWslGuestProcessInventoryPayload(
      payload('row 100 90 90 100 100 pts/0 Sl+ 12345 tool arg   '),
      'Ubuntu'
    )
    expect(inventory.rows[0]?.command).toBe('tool arg   ')
  })

  it('rejects a partial capture instead of treating it as an empty inventory', () => {
    expect(() =>
      parseWslGuestProcessInventoryPayload(`boot ${bootId}\ncount 0 1\n`, 'Ubuntu')
    ).toThrow('row_count_mismatch')
  })

  it('fences boot, start-time, tty, and foreground group before recognizing agents', () => {
    const inventory = parseWslGuestProcessInventoryPayload(
      payload(
        [
          'row 100 90 90 100 120 pts/0 Ss+ 12345 bash',
          'row 120 100 100 120 120 pts/0 Sl+ 54321 codex --flag'
        ].join('\n'),
        2
      ),
      'Ubuntu'
    )
    const resolved = resolveWslGuestForegroundProcess(inventory, {
      distro: 'Ubuntu',
      bootId,
      shellPid: 100,
      shellStartTime: 12345,
      tty: '/dev/pts/0'
    })
    expect(resolved).toMatchObject({ status: 'live', processName: 'codex' })
    if (resolved.status === 'live') {
      expect(resolved.anchor).toMatchObject({
        bootId,
        shellStartTime: 12345,
        tty: '/dev/pts/0'
      })
    }
    expect(
      resolveWslGuestForegroundProcess(inventory, {
        distro: 'Ubuntu',
        bootId: 'different',
        shellPid: 100,
        shellStartTime: 12345,
        tty: '/dev/pts/0'
      })
    ).toEqual({ status: 'unverifiable', reason: 'boot_id_mismatch' })
    expect(
      resolveWslGuestForegroundProcess(inventory, {
        distro: 'Ubuntu',
        bootId,
        shellPid: 100,
        shellStartTime: 999,
        tty: '/dev/pts/0'
      })
    ).toEqual({ status: 'unverifiable', reason: 'pid_reused' })
  })

  it('resolves against a prebuilt inventory index without rescanning rows', () => {
    const inventory = parseWslGuestProcessInventoryPayload(
      payload(
        [
          'row 100 90 90 100 100 pts/0 Ss+ 12345 bash',
          'row 101 100 100 101 101 pts/0 Sl+ 54321 codex'
        ].join('\n'),
        2
      ),
      'Ubuntu'
    )
    const indexes = {
      byPid: new Map(),
      byForegroundGroup: new Map(),
      multiplexerRows: []
    }
    expect(
      resolveWslGuestForegroundProcess(
        inventory,
        { distro: 'Ubuntu', bootId, shellPid: 100, shellStartTime: 12345, tty: '/dev/pts/0' },
        indexes
      )
    ).toEqual({ status: 'unverifiable', reason: 'anchor_missing' })
  })

  it('does not claim identity across a multiplexer boundary', () => {
    const inventory = parseWslGuestProcessInventoryPayload(
      payload(
        [
          'row 100 90 90 100 110 pts/0 Ss+ 12345 bash',
          'row 110 100 100 110 110 pts/0 S+ 12346 tmux new-session',
          'row 120 110 110 120 120 pts/1 Sl+ 12347 codex'
        ].join('\n'),
        3
      ),
      'Ubuntu'
    )
    expect(
      resolveWslGuestForegroundProcess(inventory, {
        distro: 'Ubuntu',
        bootId,
        shellPid: 100,
        shellStartTime: 12345,
        tty: '/dev/pts/0'
      })
    ).toEqual({ status: 'unverifiable', reason: 'multiplexer_boundary' })
  })

  it('single-flights and memoizes independently per distro', async () => {
    let calls = 0
    let now = 0
    const reader = createWslGuestProcessInventoryReader({
      now: () => now,
      run: async (distro) => {
        calls += 1
        return {
          status: 'ok',
          inventory: { distro, bootId, rows: [] }
        }
      }
    })
    const [a, b] = await Promise.all([reader.read(' Ubuntu '), reader.read('ubuntu')])
    expect(a).toEqual(b)
    expect(calls).toBe(1)
    await reader.read('Debian')
    expect(calls).toBe(2)
    now = 501
    await reader.read('Ubuntu')
    expect(calls).toBe(3)
  })

  it('bounds the derived inventory cache and evicts the least-recently-used distro', async () => {
    let calls = 0
    const reader = createWslGuestProcessInventoryReader({
      run: async (distro) => {
        calls += 1
        return { status: 'ok', inventory: { distro, bootId, rows: [] } }
      }
    })
    for (let index = 0; index < 40; index += 1) {
      await reader.read(`distro-${index}`)
    }
    expect(calls).toBe(40)
    await reader.read('distro-0')
    expect(calls).toBe(41)
    await reader.read('distro-39')
    expect(calls).toBe(41)
  })

  it('passes caller cancellation and deadline through to the guest probe', async () => {
    let observedOpts: { deadlineMs?: number; signal?: AbortSignal } | undefined
    const run = vi.fn(
      async (distro: string, opts?: { deadlineMs?: number; signal?: AbortSignal }) => {
        observedOpts = opts
        return { status: 'ok' as const, inventory: { distro, bootId, rows: [] } }
      }
    )
    const reader = createWslGuestProcessInventoryReader({ run, now: () => 0 })
    const signal = new AbortController().signal
    await reader.read('Ubuntu', { deadlineMs: 1234, signal })
    expect(run).toHaveBeenCalledOnce()
    expect(observedOpts?.deadlineMs).toBe(1234)
    expect(observedOpts?.signal).toBe(signal)
  })

  it('bounds the guest process timeout by the caller deadline', async () => {
    runProcessMock.mockResolvedValue({ code: 127, stdout: '', stderr: '', timedOut: false })
    resetWslGuestProcessInventoryForTests()
    const signal = new AbortController().signal
    const deadlineMs = Date.now() + 1_000
    await readWslGuestProcessInventory('Ubuntu', { deadlineMs, signal })
    const spec = runProcessMock.mock.calls[0]?.[0] as {
      timeoutMs?: number
      signal?: AbortSignal
    }
    expect(spec.timeoutMs).toBeGreaterThan(0)
    expect(spec.timeoutMs).toBeLessThanOrEqual(1_000)
    expect(spec.signal).toBe(signal)
  })

  it.each([1, 8, 32])('uses one guest inventory for a %s-pane burst', async (paneCount) => {
    let calls = 0
    const reader = createWslGuestProcessInventoryReader({
      run: async (distro) => {
        calls += 1
        return { status: 'ok', inventory: { distro, bootId, rows: [] } }
      }
    })
    await Promise.all(Array.from({ length: paneCount }, () => reader.read('Ubuntu')))
    expect(calls).toBe(1)
  })

  it('uses the fenced --exec command and reports a missing ps as unverifiable', async () => {
    runProcessMock.mockResolvedValue({ code: 127, stdout: '', stderr: '', timedOut: false })
    resetWslGuestProcessInventoryForTests()
    await expect(readWslGuestProcessInventory('Ubuntu')).resolves.toEqual({
      status: 'unverifiable',
      reason: 'ps_unavailable'
    })
    const spec = runProcessMock.mock.calls[0]?.[0]
    expect(spec.args).toContain('--exec')
    expect(spec.args).toContain('sh')
    expect(spec.args.join(' ')).not.toMatch(/__ORCA_WSL_CAPTURE_BEGIN_[^$]/)
    expect(spec.env.ORCA_WSL_CAPTURE_NONCE).toMatch(/^[a-z0-9]+$/)
  })
})
