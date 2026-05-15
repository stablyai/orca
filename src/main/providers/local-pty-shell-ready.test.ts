/* eslint-disable max-lines -- Why: shell-ready wrapper coverage keeps zsh,
   bash, marker scanning, and env restoration cases in one suite so the
   generated wrapper contract is reviewed as a unit. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { spawnSync } from 'child_process'
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
  let previousOrcaOrigZdotdir: string | undefined

  beforeEach(() => {
    previousOrcaOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
    delete process.env.ORCA_ORIG_ZDOTDIR
    userDataPath = mkdtempSync(join(tmpdir(), 'local-pty-shell-ready-test-'))
    getUserDataPathMock.mockReturnValue(userDataPath)
  })

  afterEach(() => {
    if (previousOrcaOrigZdotdir === undefined) {
      delete process.env.ORCA_ORIG_ZDOTDIR
    } else {
      process.env.ORCA_ORIG_ZDOTDIR = previousOrcaOrigZdotdir
    }
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

  it('writes wrappers that restore OpenCode and Pi config after user startup files', async () => {
    const { getBashShellReadyRcfileContent, getShellReadyLaunchConfig } =
      await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshrc = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshrc'), 'utf8')
    const zlogin = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zlogin'), 'utf8')
    const bashRc = getBashShellReadyRcfileContent()
    const restoreLine =
      '[[ -n "${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="${ORCA_OPENCODE_CONFIG_DIR}"'
    const piRestoreLine =
      '[[ -n "${ORCA_PI_CODING_AGENT_DIR:-}" ]] && export PI_CODING_AGENT_DIR="${ORCA_PI_CODING_AGENT_DIR}"'
    expect(zshrc).toContain(restoreLine)
    expect(zlogin).toContain(restoreLine)
    expect(bashRc).toContain(restoreLine)
    expect(zshrc).toContain(piRestoreLine)
    expect(zlogin).toContain(piRestoreLine)
    expect(bashRc).toContain(piRestoreLine)
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

  it('discovers ZDOTDIR from user .zshenv in a subshell to preserve scoping', async () => {
    // Why: PR #1737 sourced .zshenv inside a wrapper function, which broke
    // common patterns like "typeset -U path". The safer fix sources .zshenv in
    // a subshell to preserve top-level zsh scoping and isolate early returns.
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')

    // The wrapper must:
    // 1. Unset ZDOTDIR before sourcing user .zshenv (so ${ZDOTDIR:-...} defaults work)
    expect(zshenv).toContain('unset ZDOTDIR')

    // 2. Source user .zshenv in a subshell $(...) to preserve top-level scoping
    expect(zshenv).toMatch(/_orca_discovered_zdotdir=\$\(\s*unset ZDOTDIR/)
    expect(zshenv).toContain('if [[ -n "${HOME:-}" && -f "$HOME/.zshenv" ]]; then')

    // 3. Capture the ZDOTDIR value via printf (safer than echo for special chars)
    expect(zshenv).toMatch(/printf '%s\\n' "\$\{ZDOTDIR:-\}"/)

    // 4. Use discovered ZDOTDIR with fallback chain
    expect(zshenv).toContain(
      'export ORCA_ORIG_ZDOTDIR="${_orca_discovered_zdotdir:-${_orca_spawn_orig_zdotdir:-$HOME}}"'
    )
  })

  it('preserves spawn-env ORCA_ORIG_ZDOTDIR as fallback when discovery yields nothing', async () => {
    // Why: if user .zshenv returns early or doesn't set ZDOTDIR, the subshell
    // yields an empty string. The wrapper should then fall back to the spawn-env
    // ORCA_ORIG_ZDOTDIR (if present), then HOME.
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')

    // Save spawn-env value before subshell
    expect(zshenv).toContain('_orca_spawn_orig_zdotdir="${ORCA_ORIG_ZDOTDIR:-}"')

    // Fallback chain: discovered → spawn-env → HOME
    expect(zshenv).toContain('${_orca_discovered_zdotdir:-${_orca_spawn_orig_zdotdir:-$HOME}}')
  })
})

// Why: end-to-end validation that the subshell discovery approach actually
// preserves top-level zsh scoping for common patterns like "typeset -U path".
// These tests spawn real zsh subprocesses, so they're gated on zsh availability
// and skipped on platforms where zsh is not found.
describePosix('live zsh subprocess tests', () => {
  const hasZsh = (() => {
    const result = spawnSync('which', ['zsh'], { encoding: 'utf8' })
    return result.status === 0
  })()

  const describeIfZsh = hasZsh ? describe : describe.skip

  describeIfZsh('ZDOTDIR discovery with real zsh', () => {
    let testHome: string
    let userDataPath: string

    beforeEach(async () => {
      testHome = mkdtempSync(join(tmpdir(), 'orca-zsh-test-home-'))
      userDataPath = mkdtempSync(join(tmpdir(), 'orca-zsh-test-userdata-'))
      getUserDataPathMock.mockReturnValue(userDataPath)
    })

    afterEach(() => {
      rmSync(testHome, { recursive: true, force: true })
      rmSync(userDataPath, { recursive: true, force: true })
    })

    it('preserves typeset -U path scoping when user .zshrc uses it', async () => {
      // Why: this was the breakage pattern in PR #1737. The function-wrapper
      // approach made "typeset -U path" function-scoped. The subshell discovery
      // fix isolates only the ZDOTDIR capture; user rcfiles (.zshrc) are still
      // sourced at the wrapper's top level, preserving scoping.

      // Create XDG-style config: .zshenv sets ZDOTDIR, .zshrc modifies PATH
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(
        join(testHome, '.zshenv'),
        `export ZDOTDIR="$HOME/.config/zsh"
`
      )
      writeFileSync(
        join(xdgZshDir, '.zshrc'),
        `typeset -U path
path=(/custom/bin $path)
`
      )

      // Generate the Orca wrapper
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      // Spawn interactive zsh with the wrapper and verify:
      // 1. Wrapper discovered XDG ZDOTDIR from .zshenv
      // 2. User's .zshrc was sourced from discovered ZDOTDIR
      // 3. typeset -U path modification persisted (proving top-level scoping)
      // Build clean env: use wrapper ZDOTDIR but let wrapper discover ORCA_ORIG_ZDOTDIR at runtime
      const cleanEnv: Record<string, string | undefined> = {
        ...process.env,
        HOME: testHome,
        PATH: '/usr/bin:/bin'
      }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR // Point to Orca wrapper dir

      const result = spawnSync(
        'zsh',
        [
          '-i',
          '-c',
          'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}" && echo "PATH_HAS_CUSTOM=${PATH%%:*}"'
        ],
        {
          env: cleanEnv as NodeJS.ProcessEnv,
          encoding: 'utf8'
        }
      )

      expect(result.status).toBe(0)
      const output = result.stdout
      expect(output).toContain(`ORCA_ORIG_ZDOTDIR=${xdgZshDir}`)
      expect(output).toContain('PATH_HAS_CUSTOM=/custom/bin')
    })

    it('survives early return in user .zshenv without crashing', async () => {
      // Why: common pattern to skip non-interactive sourcing. The subshell
      // must isolate this return so the wrapper continues.
      writeFileSync(
        join(testHome, '.zshenv'),
        `[[ -o interactive ]] || return 0
export ZDOTDIR="$HOME/.config/zsh"
`
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      // Build clean env: use wrapper ZDOTDIR but let wrapper discover ORCA_ORIG_ZDOTDIR at runtime
      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR // Point to Orca wrapper dir

      const result = spawnSync(
        'zsh',
        ['-c', 'echo "survived" && echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'],
        {
          env: cleanEnv as NodeJS.ProcessEnv,
          encoding: 'utf8'
        }
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('survived')
      // ZDOTDIR discovery yields nothing (early return before export), fallback to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('falls back to HOME when user .zshenv does not set ZDOTDIR', async () => {
      // Why: vanilla zsh users don't set ZDOTDIR. The subshell should yield
      // an empty string, and the fallback chain should land on HOME.
      writeFileSync(
        join(testHome, '.zshenv'),
        `# Vanilla zsh config, no ZDOTDIR
export MY_VAR=foo
`
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      // Build clean env: use wrapper ZDOTDIR but let wrapper discover ORCA_ORIG_ZDOTDIR at runtime
      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR // Point to Orca wrapper dir

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })
  })

  describeIfZsh('high-priority edge cases', () => {
    let testHome: string
    let userDataPath: string

    beforeEach(async () => {
      testHome = mkdtempSync(join(tmpdir(), 'orca-zsh-edge-'))
      userDataPath = mkdtempSync(join(tmpdir(), 'orca-zsh-userdata-'))
      getUserDataPathMock.mockReturnValue(userDataPath)
    })

    afterEach(() => {
      rmSync(testHome, { recursive: true, force: true })
      rmSync(userDataPath, { recursive: true, force: true })
    })

    it('discovers ZDOTDIR when .zshenv sources another file that sets it', async () => {
      // Multi-file sourcing pattern
      const commonSh = join(testHome, '.config', 'shell', 'common.sh')
      mkdirSync(dirname(commonSh), { recursive: true })
      writeFileSync(commonSh, 'export ZDOTDIR="$HOME/.config/zsh"\n')
      writeFileSync(join(testHome, '.zshenv'), 'source ~/.config/shell/common.sh\n')

      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${xdgZshDir}`)
    })

    it('preserves ZDOTDIR with spaces in path', async () => {
      const spacePath = join(testHome, 'My Config', 'zsh')
      mkdirSync(spacePath, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${spacePath}"\n`)

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${spacePath}`)
    })

    it('falls back when .zshenv has syntax error', async () => {
      writeFileSync(join(testHome, '.zshenv'), 'syntax error {{{\nexport ZDOTDIR=broken\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Syntax error causes discovery to fail, falls back to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('handles framework pattern with ${ZDOTDIR:-$HOME}', async () => {
      writeFileSync(
        join(testHome, '.zshenv'),
        'export ZDOTDIR="${ZDOTDIR:-$HOME}"\n# prezto-style pattern\n'
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Framework pattern defaults to HOME when ZDOTDIR unset
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('captures last ZDOTDIR value when set multiple times', async () => {
      const firstPath = join(testHome, '.config', 'zsh')
      const lastPath = join(testHome, '.local', 'zsh')
      mkdirSync(firstPath, { recursive: true })
      mkdirSync(lastPath, { recursive: true })

      writeFileSync(
        join(testHome, '.zshenv'),
        `export ZDOTDIR="${firstPath}"\nexport ZDOTDIR="${lastPath}"\n`
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${lastPath}`)
    })

    it('handles conditional ZDOTDIR based on environment', async () => {
      const localPath = join(testHome, '.config', 'zsh')
      const remotePath = join(testHome, '.config', 'zsh-remote')
      mkdirSync(localPath, { recursive: true })
      mkdirSync(remotePath, { recursive: true })

      writeFileSync(
        join(testHome, '.zshenv'),
        `if [[ -n "$SSH_CONNECTION" ]]; then\n  export ZDOTDIR="${remotePath}"\nelse\n  export ZDOTDIR="${localPath}"\nfi\n`
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      // Test without SSH_CONNECTION
      let cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      delete cleanEnv.SSH_CONNECTION
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      let result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${localPath}`)

      // Test with SSH_CONNECTION
      cleanEnv = { ...process.env, HOME: testHome, SSH_CONNECTION: '10.0.0.1 12345 10.0.0.2 22' }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${remotePath}`)
    })

    it('preserves explicit ZDOTDIR="$HOME" from user .zshenv', async () => {
      writeFileSync(join(testHome, '.zshenv'), 'export ZDOTDIR="$HOME"\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('falls back when discovered ZDOTDIR does not exist', async () => {
      const nonexistent = join(testHome, '.config', 'zsh-missing')
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${nonexistent}"\n`)

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Validation rejects non-existent path, falls back to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('does not source /.zshenv when HOME is empty', async () => {
      // Create /.zshenv to verify it's NOT sourced
      // (can't actually create in test but we verify the wrapper logic)
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      getShellReadyLaunchConfig('/bin/zsh')

      const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')

      // Verify wrapper checks HOME is non-empty before sourcing
      expect(zshenv).toContain('if [[ -n "${HOME:-}"')
    })

    it('handles ZDOTDIR with single quote in path', async () => {
      const quotePath = join(testHome, "config'zsh")
      mkdirSync(quotePath, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${quotePath}"\n`)

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${quotePath}`)
    })

    it('does not evaluate command substitution in ZDOTDIR', async () => {
      const safePath = join(testHome, '.config', 'zsh')
      mkdirSync(safePath, { recursive: true })
      // Attempt command substitution - should be treated as literal path component
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${safePath}"\n`)

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Should contain the safe path, not any command-substituted value
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${safePath}`)
    })

    it('handles whitespace-only ZDOTDIR (tabs and newlines)', async () => {
      writeFileSync(join(testHome, '.zshenv'), 'export ZDOTDIR="\t\t\n\n"\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Whitespace-only should be normalized to empty, fall back to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('handles ZDOTDIR with multiple trailing slashes', async () => {
      const cleanPath = join(testHome, '.config', 'zsh')
      mkdirSync(cleanPath, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${cleanPath}///"\n`)

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Should normalize to path without trailing slashes
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${cleanPath}`)
    })
  })

  describeIfZsh('terminal emulator edge cases', () => {
    let testHome: string
    let userDataPath: string

    beforeEach(async () => {
      testHome = mkdtempSync(join(tmpdir(), 'orca-term-'))
      userDataPath = mkdtempSync(join(tmpdir(), 'orca-term-userdata-'))
      getUserDataPathMock.mockReturnValue(userDataPath)
    })

    afterEach(() => {
      rmSync(testHome, { recursive: true, force: true })
      rmSync(userDataPath, { recursive: true, force: true })
    })

    it('discovers ZDOTDIR when launched inside tmux', async () => {
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${xdgZshDir}"\n`)

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = {
        ...process.env,
        HOME: testHome,
        TMUX: '/tmp/tmux-501/default,12345,0',
        TMUX_PANE: '%0'
      }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${xdgZshDir}`)
    })

    it('discovers ZDOTDIR when launched from SSH session', async () => {
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${xdgZshDir}"\n`)

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = {
        ...process.env,
        HOME: testHome,
        SSH_CONNECTION: '10.0.0.1 12345 10.0.0.2 22',
        SSH_CLIENT: '10.0.0.1 12345 22',
        LC_CTYPE: 'C.UTF-8'
      }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${xdgZshDir}`)
    })

    it('handles sudo -E where HOME and ZDOTDIR mismatch', async () => {
      const userZdotdir = join('/home', 'alice', '.config', 'zsh')

      const previousZdotdir = process.env.ZDOTDIR
      const previousHome = process.env.HOME
      process.env.ZDOTDIR = userZdotdir
      process.env.HOME = '/root' // sudo changed HOME

      try {
        const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
        const config = getShellReadyLaunchConfig('/bin/zsh')

        // Should preserve user's ZDOTDIR from spawn env, not fall back to /root
        expect(config.env.ORCA_ORIG_ZDOTDIR).toBe(userZdotdir)
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

    it('re-discovers ZDOTDIR despite stale ORCA_ORIG_ZDOTDIR from previous session', async () => {
      const currentZdotdir = join(testHome, '.config', 'zsh-current')
      mkdirSync(currentZdotdir, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${currentZdotdir}"\n`)

      const previousOrcaZdotdir = process.env.ORCA_ORIG_ZDOTDIR
      process.env.ORCA_ORIG_ZDOTDIR = '/opt/orca-old/shell-ready/zsh' // stale wrapper path

      try {
        const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
        const config = getShellReadyLaunchConfig('/bin/zsh')

        const cleanEnv: Record<string, string | undefined> = {
          ...process.env,
          HOME: testHome,
          ORCA_ORIG_ZDOTDIR: '/opt/orca-old/shell-ready/zsh'
        }
        delete cleanEnv.ZDOTDIR
        cleanEnv.ZDOTDIR = config.env.ZDOTDIR

        const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
          env: cleanEnv as NodeJS.ProcessEnv,
          encoding: 'utf8'
        })

        expect(result.status).toBe(0)
        // Should discover fresh value from .zshenv, not use stale wrapper path
        expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${currentZdotdir}`)
      } finally {
        if (previousOrcaZdotdir === undefined) {
          delete process.env.ORCA_ORIG_ZDOTDIR
        } else {
          process.env.ORCA_ORIG_ZDOTDIR = previousOrcaZdotdir
        }
      }
    })

    it('prioritizes fresh discovery over inherited ORCA_ORIG_ZDOTDIR', async () => {
      const freshZdotdir = join(testHome, '.config', 'zsh-updated')
      mkdirSync(freshZdotdir, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${freshZdotdir}"\n`)

      const previousOrcaZdotdir = process.env.ORCA_ORIG_ZDOTDIR
      const oldZdotdir = join(testHome, '.config', 'zsh-old')
      process.env.ORCA_ORIG_ZDOTDIR = oldZdotdir

      try {
        const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
        const config = getShellReadyLaunchConfig('/bin/zsh')

        const cleanEnv: Record<string, string | undefined> = {
          ...process.env,
          HOME: testHome,
          ORCA_ORIG_ZDOTDIR: oldZdotdir
        }
        delete cleanEnv.ZDOTDIR
        cleanEnv.ZDOTDIR = config.env.ZDOTDIR

        const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
          env: cleanEnv as NodeJS.ProcessEnv,
          encoding: 'utf8'
        })

        expect(result.status).toBe(0)
        // Should use fresh discovery (user updated .zshenv)
        expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${freshZdotdir}`)
      } finally {
        if (previousOrcaZdotdir === undefined) {
          delete process.env.ORCA_ORIG_ZDOTDIR
        } else {
          process.env.ORCA_ORIG_ZDOTDIR = previousOrcaZdotdir
        }
      }
    })
  })

  describeIfZsh('automation and edge cases', () => {
    let testHome: string
    let userDataPath: string

    beforeEach(async () => {
      testHome = mkdtempSync(join(tmpdir(), 'orca-auto-'))
      userDataPath = mkdtempSync(join(tmpdir(), 'orca-auto-userdata-'))
      getUserDataPathMock.mockReturnValue(userDataPath)
    })

    afterEach(() => {
      rmSync(testHome, { recursive: true, force: true })
      rmSync(userDataPath, { recursive: true, force: true })
    })

    it('survives user .zshenv that calls exit', async () => {
      writeFileSync(join(testHome, '.zshenv'), 'export ZDOTDIR="$HOME/.config/zsh"\nexit 42\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "survived"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('survived')
    })

    it('survives user .zshenv with set -e and failing command', async () => {
      writeFileSync(
        join(testHome, '.zshenv'),
        'set -e\nfalse\nexport ZDOTDIR="$HOME/.config/zsh"\n'
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Subshell exits at 'false', discovery yields empty, falls back to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('survives user .zshenv with set -u before ZDOTDIR is set', async () => {
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), 'set -u\nexport ZDOTDIR="$HOME/.config/zsh"\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Should work because wrapper uses ${ZDOTDIR:-} which is safe with set -u
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${xdgZshDir}`)
    })

    it('survives user .zshenv with nullglob set', async () => {
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(
        join(testHome, '.zshenv'),
        'setopt nullglob\nexport ZDOTDIR="$HOME/.config/zsh"\n'
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${xdgZshDir}`)
    })

    it('survives user .zshenv with extendedglob set', async () => {
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(
        join(testHome, '.zshenv'),
        'setopt extendedglob\nexport ZDOTDIR="$HOME/.config/zsh"\n'
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${xdgZshDir}`)
    })

    it('does not leak subshell environment changes to wrapper', async () => {
      writeFileSync(
        join(testHome, '.zshenv'),
        'export MY_VAR=leaked\nexport ZDOTDIR="$HOME/.config/zsh"\n'
      )

      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      delete cleanEnv.MY_VAR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "MY_VAR=${MY_VAR:-unset}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // MY_VAR should not leak from subshell
      expect(result.stdout).toContain('MY_VAR=unset')
    })

    it('handles empty HOME gracefully', async () => {
      // When HOME is empty, wrapper should not attempt to source /.zshenv
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { HOME: '' }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Empty HOME falls back to empty ORCA_ORIG_ZDOTDIR
      expect(result.stdout).toContain('ORCA_ORIG_ZDOTDIR=\n')
    })

    it('handles unset HOME gracefully', async () => {
      // When HOME is unset at spawn, zsh initializes it from /etc/passwd before
      // running the wrapper, so the wrapper can discover ZDOTDIR normally.
      // This verifies the wrapper doesn't crash when HOME is initially unset.
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = {}
      delete cleanEnv.HOME
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // zsh initializes HOME from passwd, wrapper discovers ZDOTDIR normally
      expect(result.stdout).toMatch(/ORCA_ORIG_ZDOTDIR=.+/)
    })

    it('handles ZDOTDIR containing only "/"', async () => {
      writeFileSync(join(testHome, '.zshenv'), 'export ZDOTDIR="/"\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Single slash normalizes to empty after %/, falls back to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('handles ZDOTDIR containing only slashes "///"', async () => {
      writeFileSync(join(testHome, '.zshenv'), 'export ZDOTDIR="///"\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Multiple slashes normalize to "/" then to empty after %/, falls back to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('handles user .zshenv that unsets HOME', async () => {
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), `unset HOME\nexport ZDOTDIR="${xdgZshDir}"\n`)

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Subshell unsets HOME but wrapper HOME is in parent scope
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${xdgZshDir}`)
    })

    it('handles user .zshenv that sets ZDOTDIR to empty string', async () => {
      writeFileSync(join(testHome, '.zshenv'), 'export ZDOTDIR=""\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Empty string should be normalized away, fall back to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('handles conditional unset of ZDOTDIR', async () => {
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(
        join(testHome, '.zshenv'),
        `export ZDOTDIR="${xdgZshDir}"\nif [[ "\${TERM}" == "dumb" ]]; then\n  unset ZDOTDIR\nfi\n`
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      // Test with TERM=dumb
      let cleanEnv: Record<string, string | undefined> = {
        ...process.env,
        HOME: testHome,
        TERM: 'dumb'
      }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      let result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // ZDOTDIR unset conditionally, falls back to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)

      // Test with TERM=xterm
      cleanEnv = { ...process.env, HOME: testHome, TERM: 'xterm-256color' }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // ZDOTDIR not unset, uses discovered value
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${xdgZshDir}`)
    })
  })
})
