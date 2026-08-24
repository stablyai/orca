import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveGitBashPath } from '../git-bash'
import { resolveWindowsShellLaunchArgs } from './windows-shell-args'

const describeWindows = process.platform === 'win32' ? describe : describe.skip
const tempDirs: string[] = []

function makeTempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca shell preflight '))
  tempDirs.push(root)
  return root
}

function linkNodeExecutable(destination: string): void {
  try {
    linkSync(process.execPath, destination)
  } catch {
    copyFileSync(process.execPath, destination)
  }
}

function writeFailingPreflight(root: string): string {
  const executable = join(root, 'orca preflight.exe')
  linkNodeExecutable(executable)
  writeFileSync(
    join(root, 'agent'),
    [
      "const { writeFileSync } = require('node:fs')",
      "if (process.argv.slice(2).join(' ') !== 'hooks prepare-codex') process.exit(2)",
      "writeFileSync(process.env.ORCA_PREFLIGHT_MARKER, 'ran')",
      'process.exit(7)'
    ].join('\n')
  )
  return executable
}

function withPathEntry(env: NodeJS.ProcessEnv, entry: string): NodeJS.ProcessEnv {
  const result = { ...env }
  const pathKey = Object.keys(result).find((key) => key.toLowerCase() === 'path')
  const inheritedPath = pathKey ? result[pathKey] : ''
  if (pathKey) {
    delete result[pathKey]
  }
  result.PATH = `${entry};${inheritedPath ?? ''}`
  return result
}

async function runPty(options: {
  shellPath: string
  shellArgs: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  input?: string
  timeoutMs?: number
}): Promise<string> {
  const proc = pty.spawn(options.shellPath, options.shellArgs, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: options.cwd,
    env: options.env
  })
  let output = ''
  proc.onData((data) => {
    output += data
  })
  const exitPromise = new Promise<number>((resolve) => {
    proc.onExit(({ exitCode }) => resolve(exitCode))
  })
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`timed out waiting for Windows shell PTY:\n${output}`)),
      options.timeoutMs ?? 10_000
    )
  })

  try {
    if (options.input) {
      proc.write(options.input.replaceAll('\n', '\r'))
    }
    const exitCode = await Promise.race([exitPromise, timeoutPromise])
    expect(exitCode, output).toBe(0)
    return output
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
    try {
      proc.kill()
    } catch {
      // The PTY may already have exited.
    }
  }
}

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describeWindows('Windows Codex shell preflight runtime', () => {
  it('starts the cmd.exe startup command without blocking on the Codex preflight', async () => {
    const root = makeTempDir()
    const preflight = writeFailingPreflight(root)
    const preflightMarker = join(root, 'cmd-preflight-ran')
    const startupMarker = join(root, 'cmd-started')
    const resolved = resolveWindowsShellLaunchArgs(
      'cmd.exe',
      root,
      root,
      undefined,
      'echo launched>cmd-started & exit /b 0',
      preflight
    )

    // Why: an inline preflight is a CLI round-trip into the running app; a slow
    // one delayed the agent past its launch budget, so it must not be in argv.
    expect(resolved.shellArgs.join(' ')).not.toContain('prepare-codex')

    await runPty({
      shellPath: 'cmd.exe',
      shellArgs: resolved.shellArgs,
      cwd: root,
      env: {
        ...process.env,
        ORCA_CODEX_LAUNCH_PREFLIGHT: preflight,
        ORCA_PREFLIGHT_MARKER: preflightMarker
      }
    })

    expect(existsSync(preflightMarker)).toBe(false)
    expect(readFileSync(startupMarker, 'utf8').trim()).toBe('launched')
  })

  it('runs the typed-Codex wrapper through Git Bash without MSYS switch rewriting', async () => {
    const gitBash = resolveGitBashPath()
    expect(gitBash).not.toBeNull()
    if (!gitBash) {
      return
    }

    const root = makeTempDir()
    const preflight = writeFailingPreflight(root)
    const codexExecutable = join(root, 'codex.exe')
    linkNodeExecutable(codexExecutable)
    const preflightMarker = join(root, 'git-bash-preflight-ran')
    const codexMarker = join(root, 'git-bash-codex-ran')
    const previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = join(root, 'user data')

    try {
      const resolved = resolveWindowsShellLaunchArgs(
        gitBash,
        root,
        root,
        undefined,
        undefined,
        preflight
      )
      await runPty({
        shellPath: gitBash,
        shellArgs: resolved.shellArgs,
        cwd: root,
        env: {
          ...withPathEntry(process.env, root),
          CHERE_INVOKING: '1',
          HOME: root,
          ORCA_CODEX_LAUNCH_PREFLIGHT: preflight,
          ORCA_PREFLIGHT_MARKER: preflightMarker,
          ORCA_CODEX_MARKER: codexMarker,
          TERM: 'xterm-256color'
        },
        input:
          "codex -e \"require('node:fs').writeFileSync(process.env.ORCA_CODEX_MARKER,'ran')\"\nexit\n",
        // Paired "Windows low spec" QA measured 12.7–15.8s across four runs: Git Bash
        // cold-starts two large Node executables for AV scanning, so allow 25s without
        // inflating the faster cmd.exe budget.
        timeoutMs: 25_000
      })
    } finally {
      if (previousUserDataPath === undefined) {
        delete process.env.ORCA_USER_DATA_PATH
      } else {
        process.env.ORCA_USER_DATA_PATH = previousUserDataPath
      }
    }

    expect(existsSync(preflightMarker)).toBe(true)
    expect(readFileSync(codexMarker, 'utf8')).toBe('ran')
  })
})
