import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import type { PythonEnvironment, PythonEnvironments } from '../../shared/notebook-kernel-types'

const PROBE = 'import sys, platform; print(sys.executable); print(platform.python_version())'
const PROBE_TIMEOUT_MS = 10_000
const WORKSPACE_ENV_DIRS = ['.venv', '.conda']
const INSTALL_TIMEOUT_MS = 10 * 60_000
const INSTALL_DETAIL_CHARS = 4000

/** `.venv`/`.conda` interpreters from the notebook's folder up to the workspace root, nearest first. */
export function findWorkspaceInterpreters(
  notebookPath: string,
  rootPath: string | null,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync
): string[] {
  const interpreters: string[] = []
  for (let dir = dirname(notebookPath); ; dir = dirname(dir)) {
    for (const envDir of WORKSPACE_ENV_DIRS.map((name) => join(dir, name))) {
      // Windows venvs keep python.exe in Scripts\, conda envs at the env root.
      const candidates =
        platform === 'win32'
          ? [join(envDir, 'Scripts', 'python.exe'), join(envDir, 'python.exe')]
          : [join(envDir, 'bin', 'python')]
      const interpreter = candidates.find(exists)
      if (interpreter) {
        interpreters.push(interpreter)
      }
    }
    const fromRoot = rootPath === null ? '' : relative(rootPath, dir)
    if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot) || dirname(dir) === dir) {
      return interpreters
    }
  }
}

async function probe(
  program: string,
  args: string[],
  name: (executable: string) => string
): Promise<PythonEnvironment | null> {
  try {
    const result = await runProcess({
      program,
      args: [...args, '-c', PROBE],
      timeoutMs: PROBE_TIMEOUT_MS
    })
    const [executable, version] = result.stdout.trim().split(/\r?\n/)
    return result.code === 0 && executable && version
      ? { path: executable, name: name(executable), version }
      : null
  } catch {
    return null
  }
}

/** Names an interpreter after its environment folder when it lives in one. */
function environmentName(executable: string): string {
  // venvs keep python in bin/ or Scripts\; Windows conda envs keep it at the env root.
  const envDir = [dirname(dirname(executable)), dirname(executable)].find(
    (dir) => existsSync(join(dir, 'pyvenv.cfg')) || existsSync(join(dir, 'conda-meta'))
  )
  return basename(envDir ?? executable)
}

export function describePython(path: string): Promise<PythonEnvironment | null> {
  return probe(path, [], environmentName)
}

export async function listPythonEnvironments(
  notebookPath: string,
  rootPath: string | null
): Promise<PythonEnvironments> {
  const pathCommands =
    process.platform === 'win32' ? [['py', '-3'], ['python']] : [['python3'], ['python']]
  const [workspace, onPath] = await Promise.all([
    Promise.all(findWorkspaceInterpreters(notebookPath, rootPath).map(describePython)),
    Promise.all(
      pathCommands.map(([program, ...args]) =>
        probe(program, args, () => [program, ...args].join(' '))
      )
    )
  ])
  const seen = new Set<string>()
  const unique = (environments: (PythonEnvironment | null)[]): PythonEnvironment[] =>
    environments.filter((env): env is PythonEnvironment => {
      if (!env || seen.has(env.path)) {
        return false
      }
      seen.add(env.path)
      return true
    })
  return { workspace: unique(workspace), path: unique(onPath) }
}

/** `pip install -U ipykernel` into the interpreter's environment, bootstrapping pip if it has none. */
export async function installIpykernel(python: string): Promise<{ ok: boolean; detail: string }> {
  const run = (args: string[]) =>
    runProcess({ program: python, args: ['-m', ...args], timeoutMs: INSTALL_TIMEOUT_MS })
  try {
    let result = await run(['pip', 'install', '-U', 'ipykernel'])
    // Why: uv-created venvs ship without pip; the stdlib's ensurepip bootstraps it.
    if (result.code !== 0 && result.stderr.includes('No module named pip')) {
      await run(['ensurepip'])
      result = await run(['pip', 'install', '-U', 'ipykernel'])
    }
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(-INSTALL_DETAIL_CHARS)
    return { ok: result.code === 0, detail }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}
