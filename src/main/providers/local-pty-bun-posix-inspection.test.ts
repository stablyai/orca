import type { IPty } from 'node-pty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProcessTableReader from '../../shared/process-table-snapshot-reader'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import {
  confirmLocalPtyForegroundProcess,
  getLocalPtyForegroundProcess,
  hasLocalPtyChildProcesses,
  inspectLocalPtyChildProcesses
} from './local-pty-foreground-inspection'
import { LocalPtyProvider } from './local-pty-provider'
import { ptyLastRecognizedForeground, ptyProcesses, ptyShellPath } from './local-pty-provider-state'

const scans = vi.hoisted(() => ({ full: vi.fn(), fresh: vi.fn(), strict: vi.fn() }))
vi.mock('../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessTableReader>()),
  getProcessTableSnapshot: scans.full,
  getFreshProcessTableSnapshot: scans.fresh,
  getStrictProcessTableSnapshotWithAge: scans.strict
}))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const id = 'bun-pane'
const provider = new LocalPtyProvider()
let rows: ProcessTableRow[]

function row(pid: number, ppid: number, command: string, foregroundPid: number): ProcessTableRow {
  return {
    pid,
    ppid,
    command,
    pgid: pid,
    tpgid: foregroundPid,
    stat: pid === foregroundPid ? 'Ss+' : 'Ss',
    tty: 'ttys002'
  }
}

function pane(): IPty & { processNameIsSpawnFile: true } {
  return {
    pid: 100,
    process: '/bin/zsh',
    processNameIsSpawnFile: true,
    cols: 80,
    rows: 24,
    handleFlowControl: false,
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    resize() {},
    clear() {},
    write() {},
    kill() {},
    pause() {},
    resume() {}
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  scans.full.mockImplementation(async () => rows)
  scans.fresh.mockImplementation(async () => rows)
  scans.strict.mockImplementation(async () => ({ rows, capturedAgeMs: 0 }))
  ptyProcesses.set(id, pane())
  ptyShellPath.set(id, '/bin/zsh')
})
afterEach(() => {
  ptyProcesses.clear()
  ptyShellPath.clear()
  ptyLastRecognizedForeground.clear()
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
})

describe.each(['darwin', 'linux'])('Bun in-process %s inspection', (host) => {
  beforeEach(() => Object.defineProperty(process, 'platform', { value: host, configurable: true }))

  it('reports the actual foreground command and warns before closing a busy pane', async () => {
    rows = [row(100, 1, '-zsh', 101), row(101, 100, 'vim notes.md', 101)]
    expect(await provider.inspectProcess(id)).toEqual({
      foregroundProcess: 'vim',
      hasChildProcesses: true,
      childProcessEvidence: 'children'
    })
    expect(await hasLocalPtyChildProcesses(id)).toBe(true)
    expect(await confirmLocalPtyForegroundProcess(id)).toBe('vim')
    expect(scans.fresh).toHaveBeenCalledOnce()
  })

  it('proves an idle shell has no children', async () => {
    rows = [row(100, 1, '-zsh', 100)]
    expect(await provider.inspectProcess(id)).toEqual({
      foregroundProcess: 'zsh',
      hasChildProcesses: false,
      childProcessEvidence: 'no-children'
    })
    expect(await hasLocalPtyChildProcesses(id)).toBe(false)
  })

  it('does not mistake the login wrapper for a running user job', async () => {
    ptyProcesses.set(id, { ...pane(), process: '/usr/bin/login' })
    rows = [row(100, 1, '/usr/bin/login -fp test', 101), row(101, 100, '-zsh', 101)]
    expect(await provider.inspectProcess(id)).toEqual({
      foregroundProcess: 'zsh',
      hasChildProcesses: false,
      childProcessEvidence: 'no-children'
    })
  })

  it('preserves a cached agent when the foreground scan cannot verify it', async () => {
    rows = []
    scans.full.mockRejectedValue(new Error('process table unavailable'))
    scans.strict.mockRejectedValue(new Error('process table unavailable'))
    ptyLastRecognizedForeground.set(id, { name: 'claude', pid: 101, at: Date.now() })
    expect(await provider.inspectProcess(id)).toEqual({
      foregroundProcess: 'claude',
      hasChildProcesses: true,
      childProcessEvidence: 'unverifiable'
    })
    expect(await hasLocalPtyChildProcesses(id)).toBe(true)
    expect(await confirmLocalPtyForegroundProcess(id)).toBeNull()
  })

  it('returns uncertainty when the process table has no pane root', async () => {
    rows = [row(900, 1, '-zsh', 900)]
    expect(await getLocalPtyForegroundProcess(id)).toBeNull()
    expect(await inspectLocalPtyChildProcesses(id)).toBe('unverifiable')
    expect(await hasLocalPtyChildProcesses(id)).toBe(true)
  })

  it('does not resurrect an agent cache after replacement during fingerprint capture', async () => {
    rows = [row(100, 1, '-zsh', 101), row(101, 100, 'node /usr/local/bin/claude', 101)]
    scans.full
      .mockImplementationOnce(async () => rows)
      .mockImplementationOnce(async () => {
        ptyProcesses.set(id, { ...pane(), pid: 999 })
        return rows
      })
    expect(await getLocalPtyForegroundProcess(id)).toBeNull()
    expect(ptyLastRecognizedForeground.has(id)).toBe(false)
  })

  it('does not combine an old foreground with a replacement pane during a child scan', async () => {
    rows = [row(100, 1, '-zsh', 101), row(101, 100, 'vim notes.md', 101)]
    scans.strict.mockImplementationOnce(async () => {
      ptyProcesses.set(id, { ...pane(), pid: 999 })
      return { rows, capturedAgeMs: 0 }
    })
    expect(await provider.inspectProcess(id)).toEqual({
      foregroundProcess: null,
      hasChildProcesses: true,
      childProcessEvidence: 'unverifiable'
    })
  })
})
