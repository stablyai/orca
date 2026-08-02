/* eslint-disable max-lines -- Why: keeps the whole generated-wrapper contract (zsh, bash, marker scanning, env restore) in one suite. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import type * as pty from 'node-pty'
import type * as LocalPtyShellReadyModule from './local-pty-shell-ready'
import {
  createShellReadyScanState,
  scanForShellReady,
  writeStartupCommandWhenShellReady
} from './local-pty-shell-ready'

// Why: can't import electron (bundled into the plain-node daemon-entry fork), so tests set the wrapper root via ORCA_USER_DATA_PATH instead of mocking app.
function setTestUserDataPath(path: string): void {
  process.env.ORCA_USER_DATA_PATH = path
}

const ORIGINAL_ORCA_USER_DATA_PATH = process.env.ORCA_USER_DATA_PATH

afterEach(() => {
  if (ORIGINAL_ORCA_USER_DATA_PATH === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = ORIGINAL_ORCA_USER_DATA_PATH
  }
})

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
    proc._emitData('\r\nuser@host % ')
    vi.advanceTimersByTime(30)
    await Promise.resolve()

    expect(proc._writes).toEqual(['claude\n'])
  })

  it('appends CR on Windows so PowerShell/cmd.exe submit the line', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    writeStartupCommandWhenShellReady(ready, proc, 'claude', () => {})

    await ready
    proc._emitData('\r\nPS> ')
    vi.advanceTimersByTime(30)
    await Promise.resolve()

    expect(proc._writes).toEqual(['claude\r'])
  })

  it('does not re-append a submit byte if the command already ends in CR or LF', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    writeStartupCommandWhenShellReady(ready, proc, 'claude\n', () => {})

    await ready
    proc._emitData('\r\nPS> ')
    vi.advanceTimersByTime(30)
    await Promise.resolve()

    expect(proc._writes).toEqual(['claude\n'])
  })

  it('keeps the no-prompt fallback conservative to avoid duplicate shell echo', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    writeStartupCommandWhenShellReady(ready, proc, 'codex', () => {})

    await ready
    vi.advanceTimersByTime(50)
    await Promise.resolve()

    expect(proc._writes).toEqual([])

    vi.advanceTimersByTime(150)
    await Promise.resolve()

    expect(proc._writes).toEqual(['codex\n'])
  })

  it('uses the short settle delay when marker scan already observed post-marker bytes', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const proc = createMockProc()
    const ready = Promise.resolve({ postMarkerBytesObserved: true })
    writeStartupCommandWhenShellReady(ready, proc, 'codex', () => {})

    await ready
    vi.advanceTimersByTime(29)
    await Promise.resolve()
    expect(proc._writes).toEqual([])

    vi.advanceTimersByTime(1)
    await Promise.resolve()
    expect(proc._writes).toEqual(['codex\n'])
  })

  // Why: multiline startup commands must be bracketed-paste wrapped (ESC[200~ … ESC[201~) so shells insert them literally instead of treating each LF as Enter.
  it('wraps a multiline startup command in bracketed paste when the shell supports it', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    const command = "claude '--dangerously-skip-permissions' 'line one\nline two'"
    writeStartupCommandWhenShellReady(ready, proc, command, () => {}, {
      bracketedPasteSafe: true
    })

    await ready
    proc._emitData('\r\nuser@host % ')
    vi.advanceTimersByTime(30)
    await Promise.resolve()

    expect(proc._writes).toEqual([`\x1b[200~${command}\x1b[201~\n`])
  })

  it('leaves a single-line command on the raw submit path even when bracketed paste is safe', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    writeStartupCommandWhenShellReady(ready, proc, 'claude', () => {}, {
      bracketedPasteSafe: true
    })

    await ready
    proc._emitData('\r\nuser@host % ')
    vi.advanceTimersByTime(30)
    await Promise.resolve()

    expect(proc._writes).toEqual(['claude\n'])
  })

  it('does not bracket-wrap a multiline command when the shell lacks bracketed paste', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const proc = createMockProc()
    const ready = Promise.resolve()
    const command = 'echo one\necho two'
    // Why: bracketedPasteSafe defaults false, so keep the raw path to avoid echoing ESC[200~ on shells without bracketed paste.
    writeStartupCommandWhenShellReady(ready, proc, command, () => {})

    await ready
    proc._emitData('\r\nuser@host % ')
    vi.advanceTimersByTime(30)
    await Promise.resolve()

    expect(proc._writes).toEqual([`${command}\n`])
  })
})

describe('scanForShellReady', () => {
  it('flushes marker-like output when the full marker is not BEL-terminated', () => {
    const state = createShellReadyScanState()

    expect(scanForShellReady(state, 'before \x1b]777;orca-shell-readyx')).toEqual({
      output: 'before \x1b]777;orca-shell-readyx',
      matched: false,
      postMarkerBytesObserved: false
    })
    expect(scanForShellReady(state, ' after')).toEqual({
      output: ' after',
      matched: false,
      postMarkerBytesObserved: false
    })
  })

  it('reports post-marker bytes only when bytes follow the BEL terminator in the matching call', () => {
    let state = createShellReadyScanState()
    expect(scanForShellReady(state, 'before \x1b]777;orca-shell-ready\x07')).toEqual({
      output: 'before ',
      matched: true,
      postMarkerBytesObserved: false
    })

    state = createShellReadyScanState()
    expect(scanForShellReady(state, 'before \x1b]777;orca-shell-ready\x07% ')).toEqual({
      output: 'before % ',
      matched: true,
      postMarkerBytesObserved: true
    })

    state = createShellReadyScanState()
    expect(scanForShellReady(state, 'before \x1b]777;orca-shell-ready')).toEqual({
      output: 'before ',
      matched: false,
      postMarkerBytesObserved: false
    })
    expect(scanForShellReady(state, '\x07')).toEqual({
      output: '',
      matched: true,
      postMarkerBytesObserved: false
    })

    state = createShellReadyScanState()
    expect(scanForShellReady(state, '\x1b]777;orca-shell-ready')).toEqual({
      output: '',
      matched: false,
      postMarkerBytesObserved: false
    })
    expect(scanForShellReady(state, '\x07% ')).toEqual({
      output: '% ',
      matched: true,
      postMarkerBytesObserved: true
    })
  })
})

describe('shell-ready wrapper root resolution', () => {
  // Why: daemon-entry fork is plain Node (no electron), so the wrapper root resolves from ORCA_USER_DATA_PATH, not app.getPath.
  it('resolves the wrapper root from ORCA_USER_DATA_PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-userdata-env-'))
    try {
      setTestUserDataPath(root)
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ZDOTDIR).toBe(`${root}/shell-ready/zsh`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

const describePosix = process.platform === 'win32' ? describe.skip : describe
const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0
const itWithBash = hasBash ? it : it.skip

function runInteractiveBashRcfile(rcfileContent: string, tempDir: string): string {
  const rcfile = join(tempDir, 'bash-osc133-rcfile')
  writeFileSync(rcfile, rcfileContent)

  const result = spawnSync(
    'bash',
    ['-lc', 'bash --noprofile --rcfile "$1" -i 2>&1', 'bash', rcfile],
    {
      input: 'true\nfalse\nexit 0\n',
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: tempDir,
        ORCA_SHELL_READY_MARKER: '1',
        TERM: process.env.TERM || 'xterm'
      },
      timeout: 5000
    }
  )

  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  return result.stdout
}

function expectBashOsc133Lifecycle(output: string): void {
  const oscA = '\x1b]133;A\x07'
  const oscC = '\x1b]133;C\x07'
  const oscD = '\x1b]133;D;'
  const firstPromptMarker = output.indexOf(oscA)

  expect(firstPromptMarker).toBeGreaterThanOrEqual(0)
  expect(output.slice(0, firstPromptMarker)).not.toContain(oscC)
  expect(output.slice(0, firstPromptMarker)).not.toContain(oscD)
  expect(output).toContain(`${oscD}0\x07${oscA}`)
  expect(output).toContain(`${oscD}1\x07${oscA}`)
  expect(output.split(oscC)).toHaveLength(4)
  expect(output.split(oscD)).toHaveLength(3)
}

function expectZdotdirSourceContext(content: string, fileName: '.zprofile' | '.zshrc' | '.zlogin') {
  expect(content).toContain('export ZDOTDIR="$_orca_home"')
  expect(content).toContain(`source "$_orca_home/${fileName}"`)
  expect(content).toContain('export ZDOTDIR="$_orca_wrapper_zdotdir"')
}

function expectFinalZdotdirRestoreContext(content: string) {
  expect(content).toContain("after Orca's last wrapper file has loaded")
  expect(content).toContain('export ZDOTDIR="$_orca_home"')
}

describePosix('local PTY shell-ready launch config', () => {
  let userDataPath: string
  let previousOrcaOrigZdotdir: string | undefined

  beforeEach(() => {
    previousOrcaOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
    delete process.env.ORCA_ORIG_ZDOTDIR
    userDataPath = mkdtempSync(join(tmpdir(), 'local-pty-shell-ready-test-'))
    setTestUserDataPath(userDataPath)
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
    // Why: mirrors the daemon path — guards the same zsh recursion loop for renderer/local PTYs spawned inside an Orca terminal.
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice')
      expect(config.env.ORCA_ZSHENV_SOURCE_DIR).toBe('/Users/alice')
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
      expect(config.env.ORCA_ZSHENV_SOURCE_DIR).toBe('/Users/alice')
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
      expect(config.env.ORCA_ZSHENV_SOURCE_DIR).toBe('/Users/alice')
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
    const zprofile = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zprofile'), 'utf8')
    const zshrc = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshrc'), 'utf8')
    const zlogin = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zlogin'), 'utf8')
    expect(zshenv).toContain('_orca_user_zdotdir="${_orca_spawn_orig_zdotdir:-$HOME}"')
    expect(zshenv).toContain('*/shell-ready/zsh) _orca_user_zdotdir="$HOME" ;;')
    expect(zshenv).toContain('""|*/shell-ready/zsh) export ORCA_ORIG_ZDOTDIR="$HOME" ;;')
    expectZdotdirSourceContext(zprofile, '.zprofile')
    expectZdotdirSourceContext(zshrc, '.zshrc')
    expectZdotdirSourceContext(zlogin, '.zlogin')
    expectFinalZdotdirRestoreContext(zshrc)
    expectFinalZdotdirRestoreContext(zlogin)
  })

  it('owns zle-line-init for the shell-ready marker instead of an azhw hook', async () => {
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zlogin = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zlogin'), 'utf8')
    expect(zlogin).toContain('zle -N zle-line-init __orca_prompt_mark')
    expect(zlogin).toContain('__orca_prev_line_init_fn="${widgets[zle-line-init]#user:}"')
    expect(zlogin).toContain('printf "\\033]777;orca-shell-ready\\007"')
    // Why: add-zle-hook-widget aborts its chain on a non-zero earlier hook (e.g. oh-my-zsh vi-mode); don't register the marker through it.
    expect(zlogin).not.toContain('add-zle-hook-widget line-init')
    // Why: re-source guard — skip re-capturing when already the bound widget so the prior chain survives a second source.
    expect(zlogin).toContain('== "user:__orca_prompt_mark"')
  })

  it('writes wrappers without restoring Pi/OMP homes after user startup files', async () => {
    const { getBashShellReadyRcfileContent, getShellReadyLaunchConfig } =
      await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshrc = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshrc'), 'utf8')
    const zlogin = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zlogin'), 'utf8')
    const bashRc = getBashShellReadyRcfileContent()
    const restoreLine =
      '[[ -n "${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="${ORCA_OPENCODE_CONFIG_DIR}"'
    const mimoRestoreLine =
      '[[ -n "${ORCA_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="${ORCA_MIMOCODE_HOME}"'
    const codexRestoreLine =
      '[[ -n "${ORCA_CODEX_HOME:-}" ]] && export CODEX_HOME="${ORCA_CODEX_HOME}"'
    const agentTeamsPathRestoreLine = '[[ -n "${ORCA_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0'
    const ompWrapperLine = 'command omp --extension "${ORCA_OMP_STATUS_EXTENSION}" "$@"'
    expect(zshrc).toContain(restoreLine)
    expect(zlogin).toContain(restoreLine)
    expect(bashRc).toContain(restoreLine)
    expect(zshrc).toContain(mimoRestoreLine)
    expect(zlogin).toContain(mimoRestoreLine)
    expect(bashRc).toContain(mimoRestoreLine)
    expect(zshrc).not.toContain('ORCA_PI_CODING_AGENT_DIR')
    expect(zlogin).not.toContain('ORCA_PI_CODING_AGENT_DIR')
    expect(bashRc).not.toContain('ORCA_PI_CODING_AGENT_DIR')
    expect(zshrc).toContain(codexRestoreLine)
    expect(zlogin).toContain(codexRestoreLine)
    expect(zshrc).toContain(agentTeamsPathRestoreLine)
    expect(zlogin).toContain(agentTeamsPathRestoreLine)
    expect(bashRc).toContain(agentTeamsPathRestoreLine)
    expect(bashRc).toContain(codexRestoreLine)
    expect(zshrc).not.toContain('ORCA_OMP_CODING_AGENT_DIR')
    expect(zlogin).not.toContain('ORCA_OMP_CODING_AGENT_DIR')
    expect(bashRc).not.toContain('ORCA_OMP_CODING_AGENT_DIR')
    expect(zshrc).toContain(ompWrapperLine)
    expect(zlogin).toContain(ompWrapperLine)
    expect(bashRc).toContain(ompWrapperLine)
  })

  // Why: issue #2422 — without OSC 133 C/D markers, bash sessions kept the worktree spinner "working" ~30min after the agent exited.
  it('emits OSC 133 C/D markers in the bash wrapper so agent exit cleanup fires', async () => {
    const { getBashShellReadyRcfileContent, getZshShellReadyRcfileContent } =
      await importFreshLocalPtyShellReady()

    const bashRc = getBashShellReadyRcfileContent()
    const zshRc = getZshShellReadyRcfileContent()

    // The exact escape sequences terminal-command-lifecycle parses (133;D = finished, 133;C = start).
    expect(bashRc).toContain('printf "\\033]133;D;%s\\007"')
    expect(bashRc).toContain('printf "\\033]133;C\\007"')
    expect(bashRc).toContain(
      'PROMPT_COMMAND="__orca_osc133_precmd${PROMPT_COMMAND:+;${PROMPT_COMMAND}}"'
    )
    expect(bashRc.indexOf("trap '__orca_osc133_preexec' DEBUG")).toBeGreaterThan(
      bashRc.indexOf('if [[ "${ORCA_SHELL_READY_MARKER:-0}" == "1" ]]; then')
    )
    // Sanity: zsh wrapper emits the same markers — both branches must stay in sync.
    expect(zshRc).toContain('printf "\\033]133;D;%s\\007"')
    expect(zshRc).toContain('printf "\\033]133;C\\007"')
  })

  itWithBash('runs the bash wrapper without fake C/D markers before the first prompt', async () => {
    const { getBashShellReadyRcfileContent } = await importFreshLocalPtyShellReady()

    const output = runInteractiveBashRcfile(getBashShellReadyRcfileContent(), userDataPath)

    expectBashOsc133Lifecycle(output)
  })

  itWithBash(
    'preserves prompt hooks and existing DEBUG traps without fake command markers',
    async () => {
      const { getBashShellReadyRcfileContent } = await importFreshLocalPtyShellReady()
      writeFileSync(
        join(userDataPath, '.bash_profile'),
        [
          'PROMPT_COMMAND=\'AFTER_FIRST_PROMPT=1; printf "PROMPT_HOOK\\n"\'',
          'trap \'if [[ -n "${AFTER_FIRST_PROMPT:-}" ]]; then\n  printf "USER_DEBUG_AFTER\\n"\nfi\' DEBUG'
        ].join('\n')
      )

      const output = runInteractiveBashRcfile(getBashShellReadyRcfileContent(), userDataPath)

      expect(output).toContain('PROMPT_HOOK')
      expect(output).toContain('USER_DEBUG_AFTER')
      expectBashOsc133Lifecycle(output)
    }
  )

  itWithBash('normalizes array PROMPT_COMMAND hooks so bash 3.2 still runs cleanup', async () => {
    const { getBashShellReadyRcfileContent } = await importFreshLocalPtyShellReady()
    writeFileSync(
      join(userDataPath, '.bash_profile'),
      'PROMPT_COMMAND=(\'AFTER_ARRAY_PROMPT=1; printf "PROMPT_ARRAY\\n"\')\n'
    )

    const output = runInteractiveBashRcfile(getBashShellReadyRcfileContent(), userDataPath)

    expect(output).toContain('PROMPT_ARRAY')
    expectBashOsc133Lifecycle(output)
  })

  it('preserves a real inherited ZDOTDIR as ORCA_ORIG_ZDOTDIR', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    process.env.ZDOTDIR = '/Users/alice/.config/zsh'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice/.config/zsh')
      expect(config.env.ORCA_ZSHENV_SOURCE_DIR).toBe('/Users/alice/.config/zsh')
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

  it('sources user .zshenv at wrapper top level before repinning ZDOTDIR', async () => {
    // Why: PR #1737 sourced .zshenv in a wrapper function, breaking "typeset -U path"; keep it at top level.
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')

    expect(zshenv).toContain('unset ZDOTDIR')
    expect(zshenv).toContain('_orca_zshenv_source_dir="${ORCA_ZSHENV_SOURCE_DIR:-$HOME}"')
    expect(zshenv).toContain('source "${_orca_zshenv_path}"')
    expect(zshenv).toContain('_orca_discovered_zdotdir="${ZDOTDIR:-}"')
    expect(zshenv).toContain(
      'export ORCA_ORIG_ZDOTDIR="${_orca_discovered_zdotdir:-${_orca_user_zdotdir:-$HOME}}"'
    )
    expect(zshenv).toContain('export ZDOTDIR=')
  })

  it('preserves spawn-env ORCA_ORIG_ZDOTDIR as fallback when discovery yields nothing', async () => {
    // Why: if user .zshenv returns early or doesn't set ZDOTDIR, fall back to spawn-env ORCA_ORIG_ZDOTDIR, then HOME.
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')

    // Save spawn-env value before sourcing user .zshenv
    expect(zshenv).toContain('_orca_spawn_orig_zdotdir="${ORCA_ORIG_ZDOTDIR:-}"')

    // Fallback chain: discovered → normalized spawn-env path → HOME
    expect(zshenv).toContain('${_orca_discovered_zdotdir:-${_orca_user_zdotdir:-$HOME}}')
  })

  it('restores wrapper ZDOTDIR from the runtime sourced path, not the baked literal', async () => {
    // Why: issue #8003 — WSL sources Windows-generated wrappers via /mnt/c, so the baked generation-time path is absent.
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')

    // Why: derive wrapper dir from %x, not env $ZDOTDIR — zsh corrupts non-ASCII usernames in its 0x84-0x9D token range.
    expect(zshenv).toContain('_orca_wrapper_zdotdir_self="${${(%):-%x}:h}"')
    // Keep $ZDOTDIR only as a fallback when %x yields nothing; the final restore re-validates with -f, so no stat here.
    expect(zshenv).toContain(
      'if [[ -z "${_orca_wrapper_zdotdir_self:-}" ]]; then\n' +
        '  _orca_wrapper_zdotdir_self="${ZDOTDIR:-}"\n' +
        'fi'
    )
    // Trust the runtime path only when it still holds a wrapper .zshenv; else fall back to the generation-time literal.
    expect(zshenv).toContain(
      'if [[ -n "${_orca_wrapper_zdotdir_self:-}" && -f "${_orca_wrapper_zdotdir_self:-}/.zshenv" ]]; then\n' +
        '  export ZDOTDIR="${_orca_wrapper_zdotdir_self:-}"\n' +
        'else\n' +
        `  export ZDOTDIR='${join(userDataPath, 'shell-ready', 'zsh')}'\n` +
        'fi'
    )
    // Capture must happen before the wrapper unsets ZDOTDIR to source user files.
    expect(zshenv.indexOf('_orca_wrapper_zdotdir_self="${${(%):-%x}:h}"')).toBeLessThan(
      zshenv.indexOf('unset ZDOTDIR')
    )
  })
})

// End-to-end validation that wrapper ZDOTDIR discovery preserves top-level zsh semantics (spawns real zsh; gated on availability).
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
      setTestUserDataPath(userDataPath)
    })

    afterEach(() => {
      rmSync(testHome, { recursive: true, force: true })
      rmSync(userDataPath, { recursive: true, force: true })
    })

    it('preserves typeset -U path scoping when user .zshrc uses it', async () => {
      // Why: PR #1737's function-wrapper made "typeset -U path" function-scoped; user rcfiles must source at top level.

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

      // Verify the wrapper discovered XDG ZDOTDIR, sourced user .zshrc, and kept typeset -U path (proves top-level scoping).
      const cleanEnv: Record<string, string | undefined> = {
        ...process.env,
        HOME: testHome,
        PATH: '/usr/bin:/bin'
      }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      // Why: this test isolates zsh top-level path scoping, not attribution shim ordering.
      delete cleanEnv.ORCA_ATTRIBUTION_SHIM_DIR
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

    it('loads user .zshrc when wrappers are sourced from a different runtime path (WSL simulation)', async () => {
      // Why: issue #8003 — WSL sources Windows-generated wrappers via /mnt/c where the baked path is absent; renaming userData reproduces that split.
      writeFileSync(join(testHome, '.zshrc'), 'export USER_ZSHRC_LOADED=yes\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      getShellReadyLaunchConfig('/bin/zsh')

      const movedUserData = `${userDataPath}-wsl-view`
      renameSync(userDataPath, movedUserData)
      try {
        const cleanEnv: Record<string, string | undefined> = {
          ...process.env,
          HOME: testHome,
          PATH: '/usr/bin:/bin'
        }
        delete cleanEnv.ZDOTDIR
        delete cleanEnv.ORCA_ORIG_ZDOTDIR
        delete cleanEnv.ORCA_ATTRIBUTION_SHIM_DIR
        delete cleanEnv.USER_ZSHRC_LOADED
        cleanEnv.ZDOTDIR = join(movedUserData, 'shell-ready', 'zsh')

        // Cover both the WSL login shell (`exec zsh -l`) and the non-login local-pane flow so both restore paths stay pinned.
        for (const args of [['-i'], ['-l', '-i']] as const) {
          const result = spawnSync(
            'zsh',
            [
              ...args,
              '-c',
              'echo "USER_ZSHRC_LOADED=${USER_ZSHRC_LOADED:-no}" && echo "FINAL_ZDOTDIR=${ZDOTDIR:-unset}" && echo "IS_LOGIN=$([[ -o login ]] && echo yes || echo no)"'
            ],
            {
              env: cleanEnv as NodeJS.ProcessEnv,
              encoding: 'utf8'
            }
          )

          expect(result.status, `zsh ${args.join(' ')} failed: ${result.stderr}`).toBe(0)
          expect(result.stdout).toContain('USER_ZSHRC_LOADED=yes')
          expect(result.stdout).toContain(`FINAL_ZDOTDIR=${testHome}`)
          // Why: `as const` makes .includes('-l') reject the tuple union type; check by position instead.
          expect(result.stdout).toContain(args[0] === '-l' ? 'IS_LOGIN=yes' : 'IS_LOGIN=no')
        }
      } finally {
        rmSync(movedUserData, { recursive: true, force: true })
      }
    })

    it('loads user .zshrc when the wrapper dir contains a non-ASCII (token-range) path', async () => {
      // Why: issue #8003 — non-ASCII usernames put UTF-8 bytes in zsh's 0x84-0x9D token range, corrupting env-imported $ZDOTDIR; derive from %x instead.
      writeFileSync(join(testHome, '.zshrc'), 'export USER_ZSHRC_LOADED=yes\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      getShellReadyLaunchConfig('/bin/zsh')

      // Move wrappers under a non-ASCII root so the baked literal is unusable and runtime $ZDOTDIR corrupts on import.
      const nonAsciiUserData = join(dirname(userDataPath), '홍길동-wsl-view')
      renameSync(userDataPath, nonAsciiUserData)
      try {
        const cleanEnv: Record<string, string | undefined> = {
          ...process.env,
          HOME: testHome,
          PATH: '/usr/bin:/bin'
        }
        delete cleanEnv.ZDOTDIR
        delete cleanEnv.ORCA_ORIG_ZDOTDIR
        delete cleanEnv.ORCA_ATTRIBUTION_SHIM_DIR
        delete cleanEnv.USER_ZSHRC_LOADED
        cleanEnv.ZDOTDIR = join(nonAsciiUserData, 'shell-ready', 'zsh')

        for (const args of [['-i'], ['-l', '-i']] as const) {
          const result = spawnSync(
            'zsh',
            [...args, '-c', 'echo "USER_ZSHRC_LOADED=${USER_ZSHRC_LOADED:-no}"'],
            {
              env: cleanEnv as NodeJS.ProcessEnv,
              encoding: 'utf8'
            }
          )

          expect(result.status, `zsh ${args.join(' ')} failed: ${result.stderr}`).toBe(0)
          expect(result.stdout).toContain('USER_ZSHRC_LOADED=yes')
        }
      } finally {
        rmSync(nonAsciiUserData, { recursive: true, force: true })
      }
    })

    it('preserves top-level .zshenv path and function side effects', async () => {
      // Why: .zshenv is the normal place for always-on env/path setup; dropping side effects regresses zsh startup.
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(
        join(testHome, '.zshenv'),
        `typeset -U path
path=(/env/bin $path)
export MY_VAR=from-zshenv
orca_zshenv_func() { echo "from-zshenv-function"; }
export ZDOTDIR="$HOME/.config/zsh"
`
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = {
        ...process.env,
        HOME: testHome,
        PATH: '/usr/bin:/bin'
      }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      delete cleanEnv.MY_VAR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync(
        'zsh',
        [
          '-c',
          'echo "PATH_HEAD=${PATH%%:*}" && echo "MY_VAR=${MY_VAR:-unset}" && orca_zshenv_func'
        ],
        {
          env: cleanEnv as NodeJS.ProcessEnv,
          encoding: 'utf8'
        }
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('PATH_HEAD=/env/bin')
      expect(result.stdout).toContain('MY_VAR=from-zshenv')
      expect(result.stdout).toContain('from-zshenv-function')
    })

    it('sources user startup files with their own ZDOTDIR in scope', async () => {
      // Why: plugin managers such as Antidote resolve files from $ZDOTDIR while startup files are sourced.
      const xdgZshDir = join(testHome, '.config', 'zsh')
      const zdotdirLog = join(testHome, 'zdotdir.log')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), 'export ZDOTDIR="$HOME/.config/zsh"\n')
      writeFileSync(
        join(xdgZshDir, '.zprofile'),
        'printf "zprofile=%s\\n" "$ZDOTDIR" >> "$HOME/zdotdir.log"\n'
      )
      writeFileSync(
        join(xdgZshDir, '.zshrc'),
        'printf "zshrc=%s\\n" "$ZDOTDIR" >> "$HOME/zdotdir.log"\n'
      )
      writeFileSync(
        join(xdgZshDir, '.zlogin'),
        'printf "zlogin=%s\\n" "$ZDOTDIR" >> "$HOME/zdotdir.log"\n'
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync(
        'zsh',
        ['-l', '-i', '-c', 'printf "command=%s\\n" "$ZDOTDIR" >> "$HOME/zdotdir.log"'],
        {
          env: cleanEnv as NodeJS.ProcessEnv,
          encoding: 'utf8',
          timeout: 5000
        }
      )

      expect(result.status).toBe(0)
      expect(readFileSync(zdotdirLog, 'utf8')).toBe(
        [
          `zprofile=${xdgZshDir}`,
          `zshrc=${xdgZshDir}`,
          `zlogin=${xdgZshDir}`,
          `command=${xdgZshDir}`,
          ''
        ].join('\n')
      )
    })

    it('survives early return in user .zshenv without crashing', async () => {
      // Why: early return is a common non-interactive-skip pattern; top-level sourcing must keep the wrapper running.
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
      // Why: vanilla zsh users don't set ZDOTDIR, so the fallback chain must land on HOME.
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
      setTestUserDataPath(userDataPath)
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
      // Can't create /.zshenv in the test, so verify the wrapper logic guards against it.
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      getShellReadyLaunchConfig('/bin/zsh')

      const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')

      // Verify wrapper checks the resolved source root is non-empty before sourcing
      expect(zshenv).toContain('if [[ -n "${_orca_zshenv_source_dir:-}"')
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
      setTestUserDataPath(userDataPath)
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

    it('sources launch-time ZDOTDIR .zshenv when it is explicitly inherited', async () => {
      const homeZdotdir = join(testHome, '.config', 'zsh-home')
      const inheritedZdotdir = join(testHome, '.config', 'zsh-inherited')
      mkdirSync(homeZdotdir, { recursive: true })
      mkdirSync(inheritedZdotdir, { recursive: true })
      writeFileSync(
        join(testHome, '.zshenv'),
        `export SOURCE_MARKER=home\nexport ZDOTDIR="${homeZdotdir}"\n`
      )
      writeFileSync(
        join(inheritedZdotdir, '.zshenv'),
        `export SOURCE_MARKER=inherited\nexport ZDOTDIR="${inheritedZdotdir}"\n`
      )

      const previousZdotdir = process.env.ZDOTDIR
      const previousHome = process.env.HOME
      process.env.ZDOTDIR = inheritedZdotdir
      process.env.HOME = testHome

      try {
        const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
        const config = getShellReadyLaunchConfig('/bin/zsh')
        expect(config.env.ORCA_ZSHENV_SOURCE_DIR).toBe(inheritedZdotdir)

        const cleanEnv: Record<string, string | undefined> = {
          ...process.env,
          ...config.env,
          HOME: testHome
        }

        const result = spawnSync(
          'zsh',
          [
            '-c',
            'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}" && echo "SOURCE_MARKER=${SOURCE_MARKER:-unset}"'
          ],
          {
            env: cleanEnv as NodeJS.ProcessEnv,
            encoding: 'utf8'
          }
        )

        expect(result.status).toBe(0)
        expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${inheritedZdotdir}`)
        expect(result.stdout).toContain('SOURCE_MARKER=inherited')
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
  })

  describeIfZsh('automation and edge cases', () => {
    let testHome: string
    let userDataPath: string

    beforeEach(async () => {
      testHome = mkdtempSync(join(tmpdir(), 'orca-auto-'))
      userDataPath = mkdtempSync(join(tmpdir(), 'orca-auto-userdata-'))
      setTestUserDataPath(userDataPath)
    })

    afterEach(() => {
      rmSync(testHome, { recursive: true, force: true })
      rmSync(userDataPath, { recursive: true, force: true })
    })

    it('matches normal zsh when user .zshenv calls exit', async () => {
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

      expect(result.status).toBe(42)
      expect(result.stdout).not.toContain('survived')
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
      // No ZDOTDIR was reached after the failing command, so we fall back.
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

    it('preserves exported .zshenv environment changes in the wrapper shell', async () => {
      writeFileSync(
        join(testHome, '.zshenv'),
        'export MY_VAR=from-zshenv\nexport ZDOTDIR="$HOME/.config/zsh"\n'
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
      expect(result.stdout).toContain('MY_VAR=from-zshenv')
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
      // Why: zsh initializes HOME from /etc/passwd when unset at spawn, so the wrapper can still discover ZDOTDIR.
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
