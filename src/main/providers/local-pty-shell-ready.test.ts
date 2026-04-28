import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import type * as pty from 'node-pty'
import type * as LocalPtyShellReadyModule from './local-pty-shell-ready'
import { writeStartupCommandWhenShellReady } from './local-pty-shell-ready'

const { getUserDataPathMock } = vi.hoisted(() => ({
  getUserDataPathMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') {
        return getUserDataPathMock()
      }
      throw new Error(`unexpected app.getPath(${name})`)
    }
  }
}))

async function importFreshLocalPtyShellReady(): Promise<typeof LocalPtyShellReadyModule> {
  vi.resetModules()
  return import('./local-pty-shell-ready')
}

type DataCb = (data: string) => void
type ExitCb = (info: { exitCode: number }) => void

function createMockProc(): pty.IPty & {
  _emitData: (data: string) => void
  _writes: string[]
} {
  let onDataCbs: DataCb[] = []
  const writes: string[] = []
  const fake = {
    pid: 1,
    cols: 80,
    rows: 24,
    process: 'bash',
    handleFlowControl: false,
    write: (data: string) => {
      writes.push(data)
    },
    resize: () => {},
    clear: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {},
    onData: (cb: DataCb) => {
      onDataCbs.push(cb)
      return {
        dispose: () => {
          onDataCbs = onDataCbs.filter((c) => c !== cb)
        }
      }
    },
    onExit: (_cb: ExitCb) => ({ dispose: () => {} }),
    _emitData: (data: string) => {
      for (const cb of onDataCbs.slice()) {
        cb(data)
      }
    },
    _writes: writes
  } as unknown as pty.IPty & { _emitData: (data: string) => void; _writes: string[] }

  return fake
}

describe('writeStartupCommandWhenShellReady', () => {
  let origPlatform: NodeJS.Platform

  beforeEach(() => {
    vi.useFakeTimers()
    origPlatform = process.platform
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: origPlatform })
  })

  it('appends LF on POSIX so bash/zsh submit the line', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    writeStartupCommandWhenShellReady(ready, proc, 'claude', () => {})

    await ready
    // flush path waits for a post-ready data chunk (prompt draw) then 30ms,
    // or falls back after 50ms if no data arrives.
    vi.advanceTimersByTime(50)
    await Promise.resolve()

    expect(proc._writes).toEqual(['claude\n'])
  })

  it('appends CR on Windows so PowerShell/cmd.exe submit the line', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    writeStartupCommandWhenShellReady(ready, proc, 'claude', () => {})

    await ready
    vi.advanceTimersByTime(50)
    await Promise.resolve()

    expect(proc._writes).toEqual(['claude\r'])
  })

  it('does not re-append a submit byte if the command already ends in CR or LF', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    writeStartupCommandWhenShellReady(ready, proc, 'claude\n', () => {})

    await ready
    vi.advanceTimersByTime(50)
    await Promise.resolve()

    expect(proc._writes).toEqual(['claude\n'])
  })
})

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('local PTY shell-ready launch config', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'local-pty-shell-ready-test-'))
    getUserDataPathMock.mockReturnValue(userDataPath)
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('falls back to HOME for ORCA_ORIG_ZDOTDIR when inherited ZDOTDIR points at a wrapper dir', async () => {
    // Why: mirrors the daemon path — guards the same zsh recursion loop for
    // PTYs spawned by the renderer/local provider when Orca is launched from
    // inside an Orca terminal (e.g. `pn dev`).
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('uses inherited ORCA_ORIG_ZDOTDIR when ZDOTDIR is an Orca wrapper dir', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    const previousOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh'
    process.env.ORCA_ORIG_ZDOTDIR = '/Users/alice/.config/zsh'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice/.config/zsh')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
      if (previousOrigZdotdir === undefined) {
        delete process.env.ORCA_ORIG_ZDOTDIR
      } else {
        process.env.ORCA_ORIG_ZDOTDIR = previousOrigZdotdir
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('falls back to HOME when inherited ORCA_ORIG_ZDOTDIR points at a wrapper dir', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    const previousOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
    const previousHome = process.env.HOME
    delete process.env.ZDOTDIR
    process.env.ORCA_ORIG_ZDOTDIR = '/some/other/orca/shell-ready/zsh'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
      if (previousOrigZdotdir === undefined) {
        delete process.env.ORCA_ORIG_ZDOTDIR
      } else {
        process.env.ORCA_ORIG_ZDOTDIR = previousOrigZdotdir
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('writes zsh wrappers that guard against ORCA_ORIG_ZDOTDIR self-loops', async () => {
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')
    expect(zshenv).toContain('*/shell-ready/zsh) export ORCA_ORIG_ZDOTDIR="$HOME" ;;')
  })

  it('preserves a real inherited ZDOTDIR as ORCA_ORIG_ZDOTDIR', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    process.env.ZDOTDIR = '/Users/alice/.config/zsh'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice/.config/zsh')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
    }
  })

  it('rejects inherited ZDOTDIR ending in /shell-ready/zsh even with a trailing slash', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh/'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('falls back to HOME when ZDOTDIR is only slashes (e.g. "/")', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('preserves ZDOTDIR that contains /shell-ready/zsh as a substring but does not end with it', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    process.env.ZDOTDIR = '/Users/alice/shell-ready/zsh-custom'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice/shell-ready/zsh-custom')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
    }
  })
})
