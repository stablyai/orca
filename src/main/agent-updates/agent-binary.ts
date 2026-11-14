import { open, realpath } from 'node:fs/promises'
import { win32 } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import {
  getTuiAgentDetectCommands,
  TUI_AGENT_CONFIG
} from '../../shared/agent-launch/catalog/tui-agent-config'
import { parseAgentVersion } from '../../shared/agent-updates/agent-version'
import type { InstallMethod } from '../../shared/agent-updates/agent-update-types'
import { extractExecutableToken } from '../../shared/managed-agent-command-token'
import { resolveCommandOnLocalPath } from '../ipc/command-path/command-path-resolver'
import { findRunnableLocalCommand } from '../ipc/preflight-command-exec'
import { buildLocalPreflightEnv } from '../ipc/preflight-local-env'

export type ResolvedAgentBinary = {
  binary: string
  installMethod: InstallMethod
  /** npm global prefix that owns the binary, when its path shows one. */
  npmPrefix?: string
}

function executableName(token: string): string {
  return token.split(/[\\/]/).pop() ?? token
}

function candidateCommands(
  agent: TuiAgent,
  overrides: Partial<Record<TuiAgent, string>> | null | undefined
): string[] {
  const names = getTuiAgentDetectCommands(TUI_AGENT_CONFIG[agent])
  const raw = overrides?.[agent]?.trim()
  if (!raw) {
    return names
  }
  // PowerShell overrides may start with the `&` call operator, which is not the executable.
  const token = extractExecutableToken(
    process.platform === 'win32' ? raw.replace(/^&\s+/, '') : raw
  )
  if (!token) {
    return []
  }
  // Why: a wrapper (npx, node, uvx) would report the launcher's version and run its update instead.
  // Windows file names are case-insensitive (`Codex.EXE` is codex).
  const name =
    process.platform === 'win32' ? executableName(token).toLowerCase() : executableName(token)
  return names.includes(name) || names.includes(name.replace(/\.[^.]+$/, '')) ? [token] : []
}

async function findBinary(command: string): Promise<string | null> {
  const onPath = await resolveCommandOnLocalPath(command, { env: buildLocalPreflightEnv() })
  if (onPath) {
    return onPath
  }
  const probe = await findRunnableLocalCommand(command)
  return probe.status === 'absent' ? null : probe.binary
}

export async function resolveAgentBinary(
  agent: TuiAgent,
  overrides: Partial<Record<TuiAgent, string>> | null | undefined
): Promise<ResolvedAgentBinary | null> {
  for (const command of candidateCommands(agent, overrides)) {
    const binary = await findBinary(command)
    if (binary) {
      return classifyInstall(binary)
    }
  }
  return null
}

const SHIM_SNIFF_BYTES = 4_096

// Why: pnpm, bun and yarn globals also live in node_modules, but `npm install -g` does not own them.
function isOtherPackageManagerPath(path: string): boolean {
  return /\/(\.pnpm|\.bun|\.yarn|yarn\/global)\//i.test(path.replaceAll('\\', '/'))
}

// Why: Windows npm `.cmd`/`.ps1` shims and pnpm/yarn shell shims are files, not symlinks into node_modules.
async function readShimHead(binary: string): Promise<string> {
  const handle = await open(binary, 'r').catch(() => null)
  if (!handle) {
    return ''
  }
  try {
    const buffer = Buffer.alloc(SHIM_SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SHIM_SNIFF_BYTES, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } catch {
    return ''
  } finally {
    await handle.close().catch(() => undefined)
  }
}

// npm's own Windows `.cmd` shim launches `<its dir>\node_modules\...`; other shims say nothing about a prefix.
const NPM_WINDOWS_SHIM_PATTERN = /%(?:dp0%|~dp0)\\node_modules\\/i

// Why: `npm install -g` must land in the prefix that owns the running binary (nvm/fnm keep one per Node).
function npmGlobalPrefix(realPath: string, binary: string, shimHead: string): string | undefined {
  const prefix =
    process.platform === 'win32'
      ? (/^(.+?)[\\/]node_modules[\\/]/i.exec(realPath)?.[1] ??
        (NPM_WINDOWS_SHIM_PATTERN.test(shimHead) ? win32.dirname(binary) : undefined))
      : /^(.+?)\/lib\/node_modules\//.exec(realPath)?.[1]
  // Never write into a Homebrew keg.
  return prefix && !prefix.replaceAll('\\', '/').includes('/Cellar/') ? prefix : undefined
}

async function classifyInstall(binary: string): Promise<ResolvedAgentBinary> {
  const realPath = await realpath(binary).catch(() => binary)
  let installMethod = detectInstallMethod(realPath)
  let shimHead = ''
  if (installMethod === 'other' && !isOtherPackageManagerPath(realPath)) {
    shimHead = await readShimHead(binary)
    if (/[\\/]node_modules[\\/]/i.test(shimHead) && !isOtherPackageManagerPath(shimHead)) {
      installMethod = 'npm'
    }
  }
  if (installMethod !== 'npm') {
    return { binary, installMethod }
  }
  const npmPrefix = npmGlobalPrefix(realPath, binary, shimHead)
  return npmPrefix ? { binary, installMethod, npmPrefix } : { binary, installMethod }
}

// Why: 'brew' is only a label so Orca leaves Homebrew installs alone; brew is never run.
function detectInstallMethod(realPath: string): InstallMethod {
  const normalized = realPath.replaceAll('\\', '/')
  // Why: Homebrew npm formulas keep node_modules inside the keg (`Cellar/<f>/<v>/libexec`), so keg first.
  if (normalized.includes('/Cellar/')) {
    return 'brew'
  }
  if (normalized.includes('/node_modules/')) {
    return isOtherPackageManagerPath(normalized) ? 'other' : 'npm'
  }
  if (normalized.includes('/homebrew/')) {
    return 'brew'
  }
  if (normalized.includes('.app/Contents/')) {
    return 'app-bundle'
  }
  return 'other'
}

export async function readInstalledVersion(
  binary: string,
  versionArgs: readonly string[]
): Promise<string | null> {
  try {
    const result = await runProcess({
      program: binary,
      args: versionArgs,
      env: buildLocalPreflightEnv() ?? process.env,
      // Why: some CLIs (hermes) take seconds to print a version while the machine is busy.
      timeoutMs: 10_000,
      maxOutputBytes: 4_096,
      killOnOutputLimit: true,
      terminationBarrier: true
    })
    if (result.code !== 0 || result.timedOut) {
      return null
    }
    return parseAgentVersion(`${result.stdout}\n${result.stderr}`)
  } catch {
    return null
  }
}
