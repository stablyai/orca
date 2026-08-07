import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'
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
  const fallbackLookupScript = buildPosixCommandPathLookupScript({
    kind: 'shell-variable',
    name: 'cmd'
  })
  const lookupScript = buildWslAgentPathLookupScript(fallbackLookupScript)
  // Parallel lookups avoid serial drvfs scans across inherited Windows PATH entries.
  const script = [
    `for cmd in ${commandList}; do`,
    '(',
    lookupScript,
    'if [ -n "$resolved" ]; then',
    `printf '${WSL_AGENT_DETECTION_PREFIX}%s\\t%s\\n' "$cmd" "$resolved";`,
    'fi',
    ') &',
    'done',
    'wait'
  ].join('\n')

  try {
    // One login-shell probe captures the user's PATH without repeated WSL cold starts.
    const { stdout } = await execWslAgentDetectionCommand(wslTarget, script)
    return parseWslDetectedCommands(stdout)
  } catch {
    return new Set()
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function buildWslAgentPathLookupScript(fallbackLookupScript: string): string {
  return [
    '_orca_fast_resolved=$(command -v "$cmd" 2>/dev/null || true)',
    'case "$_orca_fast_resolved" in',
    '  /*)',
    '    if [ -x "$_orca_fast_resolved" ] && [ ! -d "$_orca_fast_resolved" ]; then',
    '      resolved=$_orca_fast_resolved',
    '    else',
    '      resolved=',
    '    fi',
    '    ;;',
    '  "") resolved= ;;',
    '  *)',
    ...fallbackLookupScript.split('\n').map((line) => `    ${line}`),
    '    ;;',
    'esac'
  ].join('\n')
}

async function execWslAgentDetectionCommand(
  target: WslPreflightTarget,
  command: string
): Promise<{ stdout: string; stderr: string }> {
  const distroArgs = target.distro ? ['-d', target.distro] : []
  const loginShellCommand = `exec /bin/sh -c ${shellQuote(command)}`
  const commandPromise = execFileAsync(
    'wsl.exe',
    [
      ...distroArgs,
      '--',
      'sh',
      '-c',
      escapeWslShCommandForWindows(buildWslLoginShellCommand(loginShellCommand))
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
    const prefixIndex = line.indexOf(WSL_AGENT_DETECTION_PREFIX)
    if (prefixIndex < 0) {
      continue
    }
    const payload = line.slice(prefixIndex + WSL_AGENT_DETECTION_PREFIX.length)
    const separatorIndex = payload.indexOf('\t')
    if (separatorIndex <= 0) {
      continue
    }
    const command = payload.slice(0, separatorIndex)
    const resolvedPath = payload.slice(separatorIndex + 1)
    // Why: a real guest executable always resolves to a POSIX-absolute path, so
    // a Windows-style C:\ path here is spoofed/non-guest output, not an install.
    if (path.posix.isAbsolute(resolvedPath)) {
      found.add(command)
    }
  }
  return found
}
