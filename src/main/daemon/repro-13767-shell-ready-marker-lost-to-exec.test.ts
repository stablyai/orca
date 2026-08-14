import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createPtySubprocess } from './pty-subprocess'
import { Session } from './session'

const describePosix = process.platform === 'win32' ? describe.skip : describe
const hasZsh = process.platform !== 'win32' && spawnSync('/bin/zsh', ['--version']).status === 0
const hasBash = process.platform !== 'win32' && spawnSync('/bin/bash', ['--version']).status === 0
const COMMAND_OUTPUT = 'ORCA_STARTUP_COMMAND_RAN'
const READ_STARTED_FILE = '.orca-read-started'

type ShellFixture = {
  name: string
  shellPath: string
  startupFile: string
  replacement: string
  command: string
  instrumentationOutput: string
  secretRead: string
  childRead: string
}

const FIXTURES: ShellFixture[] = [
  {
    name: 'zsh profile',
    shellPath: '/bin/zsh',
    startupFile: '.zprofile',
    replacement: 'exec -a kiro-cli-term /bin/zsh -o noglobalrcs -l -i',
    command: `printf 'ORCA_STARTUP_%s:PF=%s\\n' COMMAND_RAN "\${(j:,:)precmd_functions}"\r`,
    instrumentationOutput: `${COMMAND_OUTPUT}:PF=`,
    secretRead: `: > "$HOME/${READ_STARTED_FILE}"; read -sk 1\n`,
    childRead: `/bin/zsh -fc ': > "$HOME/${READ_STARTED_FILE}"; read -sk 1'\n`
  },
  {
    name: 'zsh environment',
    shellPath: '/bin/zsh',
    startupFile: '.zshenv',
    replacement: 'exec /bin/zsh -o noglobalrcs -l -i',
    command: `printf 'ORCA_STARTUP_%s:PF=%s\\n' COMMAND_RAN "\${(j:,:)precmd_functions}"\r`,
    instrumentationOutput: `${COMMAND_OUTPUT}:PF=`,
    secretRead: `: > "$HOME/${READ_STARTED_FILE}"; read -sk 1\n`,
    childRead: `/bin/zsh -fc ': > "$HOME/${READ_STARTED_FILE}"; read -sk 1'\n`
  },
  {
    name: 'bash profile',
    shellPath: '/bin/bash',
    startupFile: '.bash_profile',
    replacement: 'exec -a figterm-test /bin/bash --noprofile --norc -l -i',
    command: `printf 'ORCA_STARTUP_%s:PC=%s\\n' COMMAND_RAN "$PROMPT_COMMAND"\r`,
    instrumentationOutput: `${COMMAND_OUTPUT}:PC=`,
    secretRead: `: > "$HOME/${READ_STARTED_FILE}"; read -s -n 1\n`,
    childRead: `/bin/bash --noprofile --norc -c ': > "$HOME/${READ_STARTED_FILE}"; read -s -n 1'\n`
  }
]

function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function waitForOutput(
  subscribe: (settle: () => void) => void,
  isDone: () => boolean,
  timeoutMs = 5_000
): Promise<void> {
  if (isDone()) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error('Timed out waiting for PTY output')),
      timeoutMs
    )
    const settle = (): void => {
      if (!isDone()) {
        return
      }
      clearTimeout(deadline)
      resolve()
    }
    subscribe(settle)
    settle()
  })
}

function waitForCondition(isDone: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const interval = setInterval(() => {
      if (!isDone()) {
        return
      }
      clearInterval(interval)
      clearTimeout(deadline)
      resolve()
    }, 10)
    const deadline = setTimeout(() => {
      clearInterval(interval)
      reject(new Error('Timed out waiting for fixture state'))
    }, timeoutMs)
  })
}

function runCleanupActions(...actions: (() => void)[]): void {
  for (const action of actions) {
    try {
      action()
    } catch {}
  }
}

type RunningFixture = {
  session: Session
  subprocess: ReturnType<typeof createPtySubprocess>
  output: () => string
  readStarted: () => boolean
  subscribe: (settle: () => void) => void
  cleanup: () => Promise<void>
}

function startFixture(
  fixture: ShellFixture,
  startupContent: string,
  extraFiles: Record<string, string> = {}
): RunningFixture {
  const tempHome = mkdtempSync(join(tmpdir(), 'orca-shell-ready-exec-'))
  const previousHome = process.env.HOME
  const previousZdotdir = process.env.ZDOTDIR
  const previousOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
  let subprocess: ReturnType<typeof createPtySubprocess> | undefined
  let session: Session | undefined
  let consoleWarnSpy: { mockRestore: () => void } | undefined
  try {
    writeFileSync(join(tempHome, fixture.startupFile), startupContent)
    for (const [fileName, content] of Object.entries(extraFiles)) {
      writeFileSync(join(tempHome, fileName), content)
    }
    process.env.HOME = tempHome
    delete process.env.ZDOTDIR
    delete process.env.ORCA_ORIG_ZDOTDIR
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    subprocess = createPtySubprocess({
      sessionId: `repro-13767-${fixture.startupFile}`,
      cols: 80,
      rows: 24,
      cwd: tempHome,
      command: fixture.command,
      shellOverride: fixture.shellPath,
      env: {
        HOME: tempHome,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        SHELL: fixture.shellPath,
        TERM: 'xterm-256color'
      },
      envToDelete: ['ORCA_EXEC_REPRO_DONE', 'ORCA_ORIG_ZDOTDIR', 'ZDOTDIR']
    })
    session = new Session({
      sessionId: `repro-13767-${fixture.startupFile}`,
      cols: 80,
      rows: 24,
      subprocess,
      shellReadySupported: true
    })
    let output = ''
    let onOutput = (): void => {}
    session.attachClient({
      onData: (data) => {
        output += data
        onOutput()
      },
      onExit: () => {}
    })
    session.write(fixture.command)
    const runningSubprocess = subprocess
    const runningSession = session
    const activeConsoleWarnSpy = consoleWarnSpy

    return {
      session: runningSession,
      subprocess: runningSubprocess,
      output: () => output,
      readStarted: () => existsSync(join(tempHome, READ_STARTED_FILE)),
      subscribe: (settle) => {
        onOutput = settle
      },
      cleanup: async () => {
        if (runningSession.isAlive) {
          try {
            await runningSession.forceKillAndWaitForExit(3_000)
          } catch {
            runCleanupActions(() => runningSubprocess.forceKill())
          }
        }
        runCleanupActions(
          () => runningSession.dispose(),
          () => activeConsoleWarnSpy.mockRestore(),
          () => restoreEnvironment(previousHome, previousZdotdir, previousOrigZdotdir),
          () => rmSync(tempHome, { recursive: true, force: true })
        )
      }
    }
  } catch (error) {
    runCleanupActions(
      () => subprocess?.forceKill(),
      () => session?.dispose(),
      () => !session && subprocess?.dispose(),
      () => consoleWarnSpy?.mockRestore(),
      () => restoreEnvironment(previousHome, previousZdotdir, previousOrigZdotdir),
      () => rmSync(tempHome, { recursive: true, force: true })
    )
    throw error
  }
}

function restoreEnvironment(
  home: string | undefined,
  zdotdir: string | undefined,
  originalZdotdir: string | undefined
): void {
  setEnvironmentValue('HOME', home)
  setEnvironmentValue('ZDOTDIR', zdotdir)
  setEnvironmentValue('ORCA_ORIG_ZDOTDIR', originalZdotdir)
}

function setEnvironmentValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

async function runExecOracle(fixture: ShellFixture): Promise<void> {
  const running = startFixture(
    fixture,
    `if [[ -z "\${ORCA_EXEC_REPRO_DONE:-}" ]]; then
  export ORCA_EXEC_REPRO_DONE=1
  ${fixture.replacement}
fi
`
  )
  try {
    await waitForOutput(running.subscribe, () => running.output().includes(COMMAND_OUTPUT))
    expect(running.session.shellState).toBe('ready')
    expect(count(running.output(), COMMAND_OUTPUT)).toBe(1)
    expect(running.output()).toContain(fixture.instrumentationOutput)
    expect(running.output()).not.toContain('orca-shell-start')
  } finally {
    await running.cleanup()
  }
}

async function runReadOracle(fixture: ShellFixture, child: boolean): Promise<void> {
  const running = startFixture(fixture, child ? fixture.childRead : fixture.secretRead)
  try {
    await waitForCondition(running.readStarted)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(running.session.shellState).toBe('pending')
    expect(running.output()).not.toContain(COMMAND_OUTPUT)

    running.subprocess.write('x\r')
    await waitForOutput(running.subscribe, () => running.output().includes(COMMAND_OUTPUT))
    expect(count(running.output(), COMMAND_OUTPUT)).toBe(1)
    expect(running.output()).not.toContain('orca-shell-start')
  } finally {
    await running.cleanup()
  }
}

describePosix('#13767 shell-ready marker loss across exec', () => {
  it('continues setup cleanup after force-kill failure', () => {
    const dispose = vi.fn()
    const restore = vi.fn()
    runCleanupActions(
      () => {
        throw new Error('force kill failed')
      },
      dispose,
      restore
    )
    expect(dispose).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()
  })

  for (const fixture of FIXTURES) {
    const runnable = fixture.shellPath.endsWith('zsh') ? hasZsh : hasBash
    const testCase = runnable ? it : it.skip
    testCase(
      `releases at the real ${fixture.name} prompt after exec`,
      () => runExecOracle(fixture),
      10_000
    )
    testCase(
      `keeps queued input out of a real ${fixture.name} silent read`,
      () => runReadOracle(fixture, false),
      10_000
    )
    testCase(
      `keeps queued input out of a child read during ${fixture.name} startup`,
      () => runReadOracle(fixture, true),
      10_000
    )
  }

  const zshFixture = FIXTURES[0] as ShellFixture
  const zshTest = hasZsh ? it : it.skip
  zshTest(
    'keeps queued input out of a zle-line-init read after exec',
    async () => {
      const running = startFixture(
        zshFixture,
        `if [[ -z "\${ORCA_EXEC_REPRO_DONE:-}" ]]; then
  export ORCA_EXEC_REPRO_DONE=1
  exec env ZDOTDIR="$HOME" /bin/zsh -o noglobalrcs -l -i
fi
`,
        {
          '.zshrc': `zle-line-init() {
  print -n 'HOOK_SECRET> '
  read -sk 1
  print -r -- HOOK_DONE
}
zle -N zle-line-init
`
        }
      )
      try {
        try {
          await waitForOutput(running.subscribe, () => running.output().includes('HOOK_SECRET> '))
        } catch (error) {
          throw new Error(`ZLE hook startup output: ${JSON.stringify(running.output())}`, {
            cause: error
          })
        }
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(running.session.shellState).toBe('pending')
        expect(running.output()).not.toContain(COMMAND_OUTPUT)

        running.subprocess.write('x')
        try {
          await waitForOutput(running.subscribe, () => running.output().includes(COMMAND_OUTPUT))
        } catch (error) {
          throw new Error(`ZLE hook output: ${JSON.stringify(running.output())}`, { cause: error })
        }
        expect(running.output()).toContain('HOOK_DONE')
        expect(count(running.output(), COMMAND_OUTPUT)).toBe(1)
      } finally {
        await running.cleanup()
      }
    },
    10_000
  )

  const sqliteTest = hasZsh && existsSync('/usr/bin/sqlite3') ? it : it.skip
  sqliteTest(
    'does not treat an exec-replaced readline program as the shell prompt',
    async () => {
      const running = startFixture(zshFixture, 'exec /usr/bin/sqlite3\n')
      try {
        await waitForOutput(running.subscribe, () => running.output().includes('sqlite> '))
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(running.session.shellState).toBe('pending')
        expect(running.output()).not.toContain(COMMAND_OUTPUT)
      } finally {
        await running.cleanup()
      }
    },
    10_000
  )

  sqliteTest(
    'does not trust a non-shell executable renamed to the shell basename',
    async () => {
      const running = startFixture(
        zshFixture,
        'ln -s /usr/bin/sqlite3 "$HOME/zsh" && exec "$HOME/zsh"\n'
      )
      try {
        await waitForOutput(running.subscribe, () => running.output().includes('sqlite> '))
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(running.session.shellState).toBe('pending')
        expect(running.output()).not.toContain(COMMAND_OUTPUT)
      } finally {
        await running.cleanup()
      }
    },
    10_000
  )

  zshTest(
    'retains the timeout backstop when zsh disables bracketed paste',
    async () => {
      const running = startFixture(
        zshFixture,
        `if [[ -z "\${ORCA_EXEC_REPRO_DONE:-}" ]]; then
  export ORCA_EXEC_REPRO_DONE=1
  exec env ZDOTDIR="$HOME" /bin/zsh -o noglobalrcs -l -i
fi
`,
        {
          '.zshrc': "zmodload zsh/zle\nunset zle_bracketed_paste\nPS1='NO_BRACKET_PROMPT> '\n"
        }
      )
      try {
        await waitForOutput(running.subscribe, () =>
          running.output().includes('NO_BRACKET_PROMPT> ')
        )
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(running.session.shellState).toBe('pending')
        expect(running.output()).not.toContain(COMMAND_OUTPUT)
      } finally {
        await running.cleanup()
      }
    },
    10_000
  )
})
