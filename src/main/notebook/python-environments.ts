import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import type { ProcessResult } from '../../shared/child-process/process-spec'
import type {
  CreateVenvResult,
  PythonEnvironment,
  PythonEnvironments
} from '../../shared/notebook-kernel-types'
import { venvInterpreterSegments } from '../../shared/notebook-venv-location'

const PROBE = 'import sys, platform; print(sys.executable); print(platform.python_version())'
const PROBE_TIMEOUT_MS = 10_000
const WORKSPACE_ENV_DIRS = ['.venv', '.conda']
const INSTALL_TIMEOUT_MS = 10 * 60_000
const INSTALL_DETAIL_CHARS = 4000
const VENV_TIMEOUT_MS = 2 * 60_000

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
      const venvInterpreter = join(envDir, ...venvInterpreterSegments(platform === 'win32'))
      // Windows conda envs keep python.exe at the env root.
      const candidates =
        platform === 'win32' ? [venvInterpreter, join(envDir, 'python.exe')] : [venvInterpreter]
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

function failureDetail(result: ProcessResult): string {
  const output = (result.stderr.trim() || result.stdout.trim()).slice(-INSTALL_DETAIL_CHARS)
  if (output) {
    return output
  }
  if (result.timedOut) {
    return 'Timed out.'
  }
  return result.signal ? `Stopped by ${result.signal}.` : `Exited with code ${result.code}.`
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `pip install -U ipykernel` into the interpreter's environment, bootstrapping pip if it has none. */
export async function installIpykernel(python: string): Promise<{ ok: boolean; detail: string }> {
  const run = (args: string[], timeoutMs = INSTALL_TIMEOUT_MS) =>
    runProcess({ program: python, args, timeoutMs })
  const pipInstall = ['-m', 'pip', 'install', '-U', 'ipykernel']
  try {
    let installed = await run(pipInstall)
    // Why: uv-created venvs ship without pip; the stdlib's ensurepip bootstraps it.
    if (installed.code !== 0 && installed.stderr.includes('No module named pip')) {
      await run(['-m', 'ensurepip'])
      installed = await run(pipInstall)
    }
    if (installed.code !== 0) {
      return { ok: false, detail: failureDetail(installed) }
    }
    // Why: pip can succeed while a dependency such as pyzmq still fails to import.
    const imported = await run(['-c', 'import ipykernel, jupyter_client.manager'], PROBE_TIMEOUT_MS)
    return imported.code === 0
      ? { ok: true, detail: '' }
      : { ok: false, detail: failureDetail(imported) }
  } catch (error) {
    return { ok: false, detail: errorDetail(error) }
  }
}

/** Creates `<parent>/.venv` from `python` unless it exists, then installs ipykernel into it. */
export async function createNotebookVenv(
  python: string,
  parent: string
): Promise<CreateVenvResult> {
  const venvPath = join(parent, '.venv')
  const interpreter = join(venvPath, ...venvInterpreterSegments(process.platform === 'win32'))
  // Why: re-running venv over an existing one can repoint it to another Python and strand its packages.
  if (!existsSync(interpreter)) {
    try {
      const created = await runProcess({
        program: python,
        args: ['-m', 'venv', venvPath],
        timeoutMs: VENV_TIMEOUT_MS
      })
      if (created.code !== 0) {
        return { ok: false, detail: failureDetail(created) }
      }
    } catch (error) {
      return { ok: false, detail: errorDetail(error) }
    }
  }
  const installed = await installIpykernel(interpreter)
  if (!installed.ok) {
    return { ok: false, detail: installed.detail }
  }
  const environment = await describePython(interpreter)
  return environment
    ? { ok: true, environment }
    : { ok: false, detail: `${interpreter} did not run after the environment was created.` }
}
