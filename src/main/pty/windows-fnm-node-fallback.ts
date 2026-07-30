import { execFile, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { win32 } from 'node:path'
import { normalizeSingleWindowsPathEntry } from '../../shared/windows-path-entry'
import { getWindowsFnmDefaultDirectory } from '../codex-cli/command'
import { getCmdExePath } from '../win32-utils'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'

const NODE_PROBE_TIMEOUT_MS = 3_000

export type WindowsNodeProbe = (env: NodeJS.ProcessEnv) => Promise<boolean>

type WindowsFnmNodeFallbackOptions = {
  homePath?: string
  platform?: NodeJS.Platform
  probeNode?: WindowsNodeProbe
  sourceEnv?: NodeJS.ProcessEnv
}

type WindowsFnmNodeFallbackRoute = {
  connectionId?: string | null
  isAgentLaunch: boolean
  isWsl: boolean
  platform?: NodeJS.Platform
}

export function shouldApplyWindowsFnmNodeFallback(route: WindowsFnmNodeFallbackRoute): boolean {
  return (
    (route.platform ?? process.platform) === 'win32' &&
    !route.connectionId &&
    !route.isWsl &&
    route.isAgentLaunch
  )
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toLowerCase()
  return Object.entries(env).find(([key]) => key.toLowerCase() === normalizedName)?.[1]
}

function mergeWindowsEnv(
  sourceEnv: NodeJS.ProcessEnv,
  overlay: Record<string, string> | undefined
): NodeJS.ProcessEnv {
  const merged = { ...sourceEnv }
  for (const [key, value] of Object.entries(overlay ?? {})) {
    for (const existingKey of Object.keys(merged)) {
      if (existingKey !== key && existingKey.toLowerCase() === key.toLowerCase()) {
        delete merged[existingKey]
      }
    }
    merged[key] = value
  }
  return merged
}

function setPath(
  env: NodeJS.ProcessEnv,
  pathKey: string,
  pathValue: string
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key.toLowerCase() !== 'path') {
      next[key] = value
    }
  }
  next[pathKey] = pathValue
  return next
}

function prependUniquePath(directory: string, inheritedPath: string): string {
  const remaining = inheritedPath
    .split(';')
    .filter((entry) => entry && entry.toLowerCase() !== directory.toLowerCase())
  return [directory, ...remaining].join(';')
}

function getProbeCwd(env: NodeJS.ProcessEnv): string {
  const systemRoot = readEnv(env, 'SystemRoot')
  const root = systemRoot && /^[a-z]:[\\/]/i.test(systemRoot) ? systemRoot : 'C:\\Windows'
  return win32.join(root, 'System32')
}

async function probeNodeWithCmd(env: NodeJS.ProcessEnv): Promise<boolean> {
  return await new Promise((resolve) => {
    // Why: cmd performs PATH and UNC lookup in its child, avoiding a main-thread CreateProcess search across network entries.
    let child: ChildProcess
    let settled = false
    let timer: NodeJS.Timeout
    try {
      child = execFile(
        getCmdExePath(),
        ['/d', '/s', '/c', 'node.exe --version'],
        { cwd: getProbeCwd(env), encoding: 'utf8', env, windowsHide: true },
        (error) => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timer)
          resolve(error === null)
        }
      )
    } catch {
      resolve(false)
      return
    }
    timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      const pid = child.pid
      void (pid ? terminateWindowsProcessTree(pid) : Promise.resolve()).finally(() =>
        resolve(false)
      )
    }, NODE_PROBE_TIMEOUT_MS)
  })
}

export async function withWindowsFnmNodeFallback(
  overlay: Record<string, string> | undefined,
  options: WindowsFnmNodeFallbackOptions = {}
): Promise<Record<string, string> | undefined> {
  if ((options.platform ?? process.platform) !== 'win32') {
    return overlay
  }

  const sourceEnv = options.sourceEnv ?? process.env
  const effectiveEnv = mergeWindowsEnv(sourceEnv, overlay)
  const probeNode = options.probeNode ?? probeNodeWithCmd
  if (await probeNode(effectiveEnv)) {
    return overlay
  }

  const pathKey =
    Object.keys(overlay ?? {}).find((key) => key.toLowerCase() === 'path') ??
    Object.keys(sourceEnv).find((key) => key.toLowerCase() === 'path') ??
    'Path'
  const inheritedPath = readEnv(effectiveEnv, 'PATH') ?? ''
  const fnmDirectory = normalizeSingleWindowsPathEntry(
    getWindowsFnmDefaultDirectory(options.homePath ?? homedir(), effectiveEnv)
  )
  if (!fnmDirectory) {
    return overlay
  }
  const candidateProbeEnv = setPath(effectiveEnv, pathKey, fnmDirectory)
  if (!(await probeNode(candidateProbeEnv))) {
    return overlay
  }

  return setPath(overlay ?? {}, pathKey, prependUniquePath(fnmDirectory, inheritedPath))
}
