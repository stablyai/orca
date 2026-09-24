import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCA_CLI_REEXEC_ENV,
  ORCA_CLI_SELF_ENV,
  runAsSessionCli,
  takeSessionCliReexec
} from './session-cli-reexec'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-session-cli-reexec-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function writeScript(name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/usr/bin/env bash\n${body}`)
  chmodSync(path, 0o755)
  return path
}

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

function exitSpy(): (code: number) => never {
  return (code: number) => {
    throw new Exited(code)
  }
}

describe('takeSessionCliReexec', () => {
  it('hands off when the invoked CLI is not the launcher the session named', () => {
    const invoked = writeScript('global-orca', 'exit 0\n')
    const named = writeScript('session-orca', 'exit 0\n')
    const env: NodeJS.ProcessEnv = {
      ORCA_CLI_COMMAND: named,
      [ORCA_CLI_SELF_ENV]: invoked,
      ORCA_AGENT_SESSION_ID: 'session-1',
      ELECTRON_RUN_AS_NODE: '1',
      ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER: '1',
      ORCA_NODE_OPTIONS: '--max-old-space-size=4096',
      ORCA_NODE_REPL_EXTERNAL_MODULE: ''
    }

    const reexec = takeSessionCliReexec({ env, argv: ['orchestration', 'check'] })

    expect(reexec).toEqual({
      target: named,
      argv: ['orchestration', 'check'],
      // What the invoked launcher was handed, so the named one sees the caller's own environment.
      env: {
        ORCA_CLI_COMMAND: named,
        ORCA_AGENT_SESSION_ID: 'session-1',
        NODE_OPTIONS: '--max-old-space-size=4096',
        [ORCA_CLI_REEXEC_ENV]: '1'
      }
    })
    // Consumed: nothing this CLI starts inherits the identity of the launcher that ran it.
    expect(env).not.toHaveProperty(ORCA_CLI_SELF_ENV)
  })

  it('stays when the invoked launcher is the named one, through a symlink', () => {
    const named = writeScript('session-orca', 'exit 0\n')
    const link = join(dir, 'usr-local-bin-orca')
    symlinkSync(named, link)

    expect(
      takeSessionCliReexec({ env: { ORCA_CLI_COMMAND: named, [ORCA_CLI_SELF_ENV]: link } })
    ).toBeNull()
  })

  it('makes at most one hop, and consumes the guard so no child inherits it', () => {
    const env: NodeJS.ProcessEnv = {
      ORCA_CLI_COMMAND: writeScript('session-orca', 'exit 0\n'),
      [ORCA_CLI_SELF_ENV]: writeScript('global-orca', 'exit 0\n'),
      [ORCA_CLI_REEXEC_ENV]: '1'
    }

    expect(takeSessionCliReexec({ env })).toBeNull()
    expect(env).not.toHaveProperty(ORCA_CLI_REEXEC_ENV)
    expect(env).not.toHaveProperty(ORCA_CLI_SELF_ENV)
  })

  it('stays when no Orca launcher named itself: a dev launcher, or an older one', () => {
    expect(
      takeSessionCliReexec({ env: { ORCA_CLI_COMMAND: writeScript('session-orca', 'exit 0\n') } })
    ).toBeNull()
  })

  it.each([
    ['a WSL guest command name', 'orca-ide'],
    ["the SSH host's relay command", 'orca']
  ])('never resolves %s against the working directory', (_label, command) => {
    writeScript(command, 'exit 0\n')
    vi.spyOn(process, 'cwd').mockReturnValue(dir)

    expect(
      takeSessionCliReexec({
        env: { ORCA_CLI_COMMAND: command, [ORCA_CLI_SELF_ENV]: writeScript('global', 'exit 0\n') }
      })
    ).toBeNull()
  })

  it('stays when the named launcher no longer exists', () => {
    expect(
      takeSessionCliReexec({
        env: {
          ORCA_CLI_COMMAND: join(dir, 'gone', 'orca'),
          [ORCA_CLI_SELF_ENV]: writeScript('global-orca', 'exit 0\n')
        }
      })
    ).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('runAsSessionCli', () => {
  it("runs the command through the session's launcher and exits with its status", async () => {
    const report = join(dir, 'report')
    const named = writeScript(
      'session-orca',
      `printf '%s|%s|%s' "$*" "$ORCA_CLI_REEXEC" "\${NODE_OPTIONS-}" > '${report}'\nexit 7\n`
    )
    const run = vi.fn(async () => {})

    await expect(
      runAsSessionCli(run, {
        env: {
          ...process.env,
          ORCA_CLI_COMMAND: named,
          [ORCA_CLI_SELF_ENV]: writeScript('global-orca', 'exit 0\n'),
          ORCA_NODE_OPTIONS: '--no-warnings'
        },
        argv: ['orchestration', 'check', '--wait'],
        exit: exitSpy()
      })
    ).rejects.toEqual(new Exited(7))

    expect(readFileSync(report, 'utf8')).toBe('orchestration check --wait|1|--no-warnings')
    expect(run).not.toHaveBeenCalled()
  })

  it('runs the command here when it is already the named CLI', async () => {
    const named = writeScript('session-orca', 'exit 0\n')
    const run = vi.fn(async () => {})

    await runAsSessionCli(run, {
      env: { ORCA_CLI_COMMAND: named, [ORCA_CLI_SELF_ENV]: named },
      exit: exitSpy()
    })

    expect(run).toHaveBeenCalledOnce()
  })

  it('runs the command here, and says so, when the named CLI cannot start', async () => {
    const named = join(dir, 'not-executable')
    writeFileSync(named, 'not a program')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const run = vi.fn(async () => {})

    await runAsSessionCli(run, {
      env: {
        ORCA_CLI_COMMAND: named,
        [ORCA_CLI_SELF_ENV]: writeScript('global-orca', 'exit 0\n')
      },
      exit: exitSpy()
    })

    expect(run).toHaveBeenCalledOnce()
    expect(String(stderr.mock.calls[0]?.[0])).toContain("could not run this session's CLI")
  })
})
