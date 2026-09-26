import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('./relay-diagnostic-log', () => ({ relayLogLine: vi.fn() }))

import {
  configureRelayBundledRipgrep,
  resolveRelayRipgrepCommand,
  retryRipgrepOnPathAfterLaunchFailure
} from './relay-bundled-ripgrep'
import { listFilesWithRg } from './fs-handler-list-files'
import { searchWithRg } from './fs-handler-utils'

type MockChild = ChildProcess & { stdout: EventEmitter; stderr: EventEmitter }

function createProcess(pid: number | undefined): MockChild {
  const child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    exitCode: null,
    signalCode: null
  })
  Object.defineProperty(child, 'pid', { configurable: true, value: pid })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double exposes only the ChildProcess members these spawners use.
  return child as unknown as MockChild
}

function failToLaunch(child: MockChild, code: string): void {
  setImmediate(() => child.emit('error', Object.assign(new Error(code), { code })))
}

function succeedWith(child: MockChild, stdout: string): void {
  setImmediate(() => {
    child.stdout.emit('data', stdout)
    child.emit('close', 0, null)
  })
}

describe('relay bundled ripgrep', () => {
  let dir: string
  let bundled: string

  beforeEach(() => {
    spawnMock.mockReset()
    dir = mkdtempSync(join(tmpdir(), 'relay-rg-'))
    bundled = join(dir, 'rg')
    writeFileSync(bundled, '')
    configureRelayBundledRipgrep(bundled)
  })

  afterEach(() => {
    configureRelayBundledRipgrep(undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  it('prefers the bundled binary and uses PATH rg when none is configured or present', () => {
    expect(resolveRelayRipgrepCommand()).toBe(bundled)
    configureRelayBundledRipgrep(join(dir, 'not-uploaded-yet', 'rg'))
    expect(resolveRelayRipgrepCommand()).toBe('rg')
    configureRelayBundledRipgrep(undefined)
    expect(resolveRelayRipgrepCommand()).toBe('rg')
  })

  it('does not blame the binary when the spawn cwd is what is missing', async () => {
    await expect(
      retryRipgrepOnPathAfterLaunchFailure(bundled, join(dir, 'missing-cwd'))
    ).resolves.toBe(false)
    expect(resolveRelayRipgrepCommand()).toBe(bundled)
    await expect(retryRipgrepOnPathAfterLaunchFailure('rg', dir)).resolves.toBe(false)
  })

  it('backs off the bundled binary after a launch failure, then tries it again', async () => {
    vi.useFakeTimers()
    try {
      await expect(retryRipgrepOnPathAfterLaunchFailure(bundled, dir)).resolves.toBe(true)
      expect(resolveRelayRipgrepCommand()).toBe('rg')
      vi.advanceTimersByTime(60_001)
      expect(resolveRelayRipgrepCommand()).toBe(bundled)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not back off on fd or process pressure', async () => {
    const error = Object.assign(new Error('EMFILE'), { code: 'EMFILE' })
    await expect(retryRipgrepOnPathAfterLaunchFailure(bundled, dir, error)).resolves.toBe(false)
    expect(resolveRelayRipgrepCommand()).toBe(bundled)
  })

  it('retries a file listing on PATH rg after the bundled binary fails to launch', async () => {
    const commands: string[] = []
    spawnMock.mockImplementation((command: string) => {
      commands.push(command)
      if (command === bundled) {
        const child = createProcess(undefined)
        failToLaunch(child, 'EACCES')
        return child
      }
      const child = createProcess(42)
      succeedWith(child, 'src/index.ts\n')
      return child
    })

    await expect(listFilesWithRg(dir, [], { maxResults: 10 })).resolves.toEqual(['src/index.ts'])
    expect(commands[0]).toBe(bundled)
    expect(commands.slice(1).every((command) => command === 'rg')).toBe(true)
    expect(resolveRelayRipgrepCommand()).toBe('rg')
  })

  it('retries a text search on PATH rg with the relay command env and a hidden window', async () => {
    const hit = JSON.stringify({
      type: 'match',
      data: {
        path: { text: join(dir, 'a.ts') },
        lines: { text: 'needle\n' },
        line_number: 1,
        submatches: [{ start: 0, end: 6 }]
      }
    })
    spawnMock.mockImplementation((command: string) => {
      if (command === bundled) {
        const child = createProcess(undefined)
        failToLaunch(child, 'ENOENT')
        return child
      }
      const child = createProcess(42)
      succeedWith(child, `${hit}\n`)
      return child
    })

    const result = await searchWithRg(dir, 'needle', { maxResults: 10 })

    expect(result.totalMatches).toBe(1)
    expect(spawnMock.mock.calls.map(([command]) => command)).toEqual([bundled, 'rg'])
    for (const [, , options] of spawnMock.mock.calls) {
      expect(options.windowsHide).toBe(true)
      expect(options.env.PATH ?? options.env.Path).toContain('.cargo')
    }
    expect(resolveRelayRipgrepCommand()).toBe('rg')
  })
})
