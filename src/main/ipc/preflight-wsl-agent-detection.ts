import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import {
  buildWslLoginShellCommand,
  escapeWslShCommandForWindows
} from '../../shared/wsl-login-shell-command'

const execFileAsync = promisify(execFile)
const WSL_AGENT_DETECTION_TIMEOUT_MS = 10000
const WSL_AGENT_DETECTION_PREFIX = '__ORCA_AGENT_PATH__'

export type WslPreflightTarget = {
  distro?: string
}

export async function detectWslCommandsOnPath(
  wslTarget: WslPreflightTarget,
  commands: readonly string[]
): Promise<Set<string>> {
  const uniqueCommands = [...new Set(commands.filter(Boolean))]
  if (uniqueCommands.length === 0) {
    return new Set()
  }

  const commandList = uniqueCommands.map(shellQuote).join(' ')
  // Why: join with newlines, not spaces. zsh treats `fi done` as a parse error
  // (it needs a separator before `done`); the login shell may be zsh, so a
  // space-joined script silently fails for every agent. Newlines are valid
  // statement separators in every POSIX shell and zsh.
  const script = [
    `for cmd in ${commandList}; do`,
    'if resolved=$(command -v "$cmd" 2>/dev/null); then',
    `printf '${WSL_AGENT_DETECTION_PREFIX}%s\\t%s\\n' "$cmd" "$resolved";`,
    'fi',
    'done'
  ].join('\n')

  try {
    // Why: WSL cold-start plus many parallel wsl.exe probes can timeout and
    // cache an empty result. One probe through the distro user's login shell
    // matches zsh/bash PATH customizations from their normal terminals.
    const { stdout } = await execWslAgentDetectionCommand(wslTarget, script)
    return parseWslDetectedCommands(stdout)
  } catch {
    return new Set()
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function execWslAgentDetectionCommand(
  target: WslPreflightTarget,
  command: string
): Promise<{ stdout: string; stderr: string }> {
  const distroArgs = target.distro ? ['-d', target.distro] : []
  const commandPromise = execFileAsync(
    'wsl.exe',
    [
      ...distroArgs,
      '--',
      'sh',
      '-c',
      escapeWslShCommandForWindows(buildWslLoginShellCommand(command))
    ],
    {
      encoding: 'utf-8',
      timeout: WSL_AGENT_DETECTION_TIMEOUT_MS
    }
  ) as Promise<{ stdout: string; stderr: string }>
  return withWslAgentDetectionTimeout(commandPromise)
}

async function withWslAgentDetectionTimeout<T>(commandPromise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      commandPromise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = Object.assign(new Error('Timed out running wsl.exe'), {
            code: 'ETIMEDOUT'
          })
          reject(error)
        }, WSL_AGENT_DETECTION_TIMEOUT_MS)
        if (typeof timeout.unref === 'function') {
          timeout.unref()
        }
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

function parseWslDetectedCommands(stdout: string): Set<string> {
  const found = new Set<string>()
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith(WSL_AGENT_DETECTION_PREFIX)) {
      continue
    }
    const payload = line.slice(WSL_AGENT_DETECTION_PREFIX.length)
    const separatorIndex = payload.indexOf('\t')
    if (separatorIndex <= 0) {
      continue
    }
    const command = payload.slice(0, separatorIndex)
    const resolvedPath = payload.slice(separatorIndex + 1)
    if (path.posix.isAbsolute(resolvedPath) || path.win32.isAbsolute(resolvedPath)) {
      found.add(command)
    }
  }
  return found
}
