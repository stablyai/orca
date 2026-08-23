import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import {
  looksLikeRepoLauncher,
  REPO_CLI_DOWNLOAD_URL,
  REPO_CLI_ORCA_RELATIVE_SEGMENTS,
  type RepoCliProbe,
  type RepoCliSource
} from '../../shared/repo-managed-cli'
import { parseWslPath } from '../wsl'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { getRepoManagedRepoToolPath } from './repo-managed-checkout'

const PYTHON_PROBE_TIMEOUT_MS = 8_000
const REPO_PROBE_TIMEOUT_MS = 12_000
const DOWNLOAD_TIMEOUT_MS = 30_000
const MIN_LAUNCHER_BYTES = 1_024
const MAX_LAUNCHER_BYTES = 512 * 1024

export const REPO_CLI_PYTHON_MISSING = 'Python 3 is required to run the Google repo CLI.'
export const REPO_CLI_INSTALL_INVALID =
  'Downloaded repo launcher did not look like the official Google repo script.'
export const REPO_CLI_INSTALL_FAILED = 'Could not install the Google repo CLI.'

export type RepoCliPathExists = (path: string) => Promise<boolean>
export type RepoCliCommandRunner = (args: {
  program: string
  args: readonly string[]
  cwd?: string
}) => Promise<{ code: number | null; stdout: string; stderr: string }>

const PYTHON_PROGRAMS = ['python3', 'python'] as const

export function getOrcaManagedRepoCliPath(home: string = homedir()): string {
  return join(home, ...REPO_CLI_ORCA_RELATIVE_SEGMENTS, 'repo')
}

export function getOrcaManagedRepoCliWindowsCmdPath(home: string = homedir()): string {
  return join(home, ...REPO_CLI_ORCA_RELATIVE_SEGMENTS, 'repo.cmd')
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function defaultRepoCliCommandRunner(args: {
  program: string
  args: readonly string[]
  cwd?: string
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const wsl = args.cwd ? parseWslPath(args.cwd) : null
  if (wsl) {
    const result = await runProcess({
      program: 'wsl.exe',
      args: buildWslExecArgs(wsl.distro, [args.program, ...args.args]),
      cwd: undefined,
      timeoutMs: REPO_PROBE_TIMEOUT_MS
    })
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  }
  const result = await runProcess({
    program: args.program,
    args: args.args,
    cwd: args.cwd,
    timeoutMs: args.program.startsWith('python') ? PYTHON_PROBE_TIMEOUT_MS : REPO_PROBE_TIMEOUT_MS
  })
  return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

export async function probePythonAvailable(
  runCommand: RepoCliCommandRunner = defaultRepoCliCommandRunner,
  cwd?: string
): Promise<boolean> {
  for (const program of PYTHON_PROGRAMS) {
    try {
      const result = await runCommand({ program, args: ['--version'], cwd })
      if (result.code === 0) {
        return true
      }
    } catch {
      // Try the next interpreter name.
    }
  }
  return false
}

async function pathRepoWorks(runCommand: RepoCliCommandRunner, cwd?: string): Promise<boolean> {
  try {
    const result = await runCommand({ program: 'repo', args: ['--help'], cwd })
    return result.code === 0
  } catch {
    return false
  }
}

export async function probeRepoCli(args: {
  mainPath?: string | null
  exists?: RepoCliPathExists
  runCommand?: RepoCliCommandRunner
  home?: string
}): Promise<RepoCliProbe> {
  const exists = args.exists ?? defaultExists
  const runCommand = args.runCommand ?? defaultRepoCliCommandRunner
  const mainPath = args.mainPath?.trim() || null
  const pythonAvailable = await probePythonAvailable(runCommand, mainPath ?? undefined)

  let source: RepoCliSource = 'missing'
  let program: string | null = null

  if (mainPath) {
    const bundled = getRepoManagedRepoToolPath(mainPath)
    if (await exists(bundled)) {
      source = 'tree'
      program = bundled
    }
  }
  if (!program) {
    const managed = getOrcaManagedRepoCliPath(args.home)
    const managedCmd =
      process.platform === 'win32' ? getOrcaManagedRepoCliWindowsCmdPath(args.home) : null
    if (managedCmd && (await exists(managedCmd))) {
      source = 'orca'
      program = managedCmd
    } else if (await exists(managed)) {
      source = 'orca'
      program = managed
    }
  }
  if (!program && (await pathRepoWorks(runCommand, mainPath ?? undefined))) {
    source = 'path'
    program = 'repo'
  }

  return {
    available: Boolean(program) && pythonAvailable,
    source,
    program,
    pythonAvailable
  }
}

export async function resolveRepoProgram(args: {
  mainPath: string
  exists?: RepoCliPathExists
  runCommand?: RepoCliCommandRunner
  home?: string
}): Promise<string> {
  const probe = await probeRepoCli(args)
  if (!probe.program || !probe.available) {
    return 'repo'
  }
  return probe.program
}

export type RepoCliDownloader = (url: string) => Promise<string>

async function defaultDownloadRepoLauncher(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`${REPO_CLI_INSTALL_FAILED} (HTTP ${response.status})`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength < MIN_LAUNCHER_BYTES || buffer.byteLength > MAX_LAUNCHER_BYTES) {
      throw new Error(REPO_CLI_INSTALL_INVALID)
    }
    return buffer.toString('utf8')
  } finally {
    clearTimeout(timer)
  }
}

function windowsRepoCmdShim(scriptFileName: string): string {
  return `@echo off\r\npy -3 "%~dp0${scriptFileName}" %*\r\nif errorlevel 1 python3 "%~dp0${scriptFileName}" %*\r\n`
}

export async function installRepoCli(args?: {
  download?: RepoCliDownloader
  home?: string
  runCommand?: RepoCliCommandRunner
}): Promise<RepoCliProbe> {
  const runCommand = args?.runCommand ?? defaultRepoCliCommandRunner
  const pythonAvailable = await probePythonAvailable(runCommand)
  if (!pythonAvailable) {
    throw new Error(REPO_CLI_PYTHON_MISSING)
  }
  const download = args?.download ?? defaultDownloadRepoLauncher
  const content = await download(REPO_CLI_DOWNLOAD_URL)
  if (!looksLikeRepoLauncher(content)) {
    throw new Error(REPO_CLI_INSTALL_INVALID)
  }
  const scriptPath = getOrcaManagedRepoCliPath(args?.home)
  await mkdir(dirname(scriptPath), { recursive: true })
  await writeFile(scriptPath, content, 'utf8')
  await chmod(scriptPath, 0o755)
  if (process.platform === 'win32') {
    await writeFile(
      getOrcaManagedRepoCliWindowsCmdPath(args?.home),
      windowsRepoCmdShim('repo'),
      'utf8'
    )
  }
  return probeRepoCli({
    home: args?.home,
    runCommand,
    mainPath: null
  })
}
