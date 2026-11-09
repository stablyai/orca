import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'

/** `module.register` (the `--import` hooks) arrived in Node 20.6; `node:test` is older. */
const MIN_NODE = [20, 6] as const

export type PluginTestNode = {
  /** Absolute path of the executable to run. */
  program: string
  /** Extra environment: Orca's own runtime needs ELECTRON_RUN_AS_NODE to act as Node. */
  env: Record<string, string>
  source: 'system' | 'orca'
  version: string
}

type Dependencies = {
  run: (spec: ProcessSpec) => Promise<ProcessResult>
  /** The runtime this CLI runs on: Electron as Node in a packaged app, or Node in development. */
  execPath: string
  version: string
  electron: string | undefined
}

const defaults = (): Dependencies => ({
  run: runProcess,
  execPath: process.execPath,
  version: process.version,
  electron: process.versions.electron
})

function supports(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number)
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
}

/**
 * The Node to run plugin tests with: the author's `node` when it is new enough, else Orca's own
 * runtime, so tests run on a machine with no Node installed. The probe asks `node` for its own
 * absolute path from an empty folder: on Windows a bare name resolves in the working directory
 * first, and the plugin folder may hold a planted `node.exe`.
 */
export async function selectPluginTestNode(
  deps: Dependencies = defaults()
): Promise<PluginTestNode> {
  const empty = await mkdtemp(join(tmpdir(), 'orca-plugin-node-'))
  const probe = await deps
    .run({
      program: 'node',
      args: ['-p', 'process.version + " " + process.execPath'],
      cwd: empty,
      timeoutMs: 10_000,
      maxOutputBytes: 4096
    })
    .catch(() => null)
    .finally(() => rm(empty, { recursive: true, force: true }))
  const answer = probe?.code === 0 ? probe.stdout.trim() : ''
  const space = answer.indexOf(' ')
  const version = space > 0 ? answer.slice(0, space) : ''
  const program = space > 0 ? answer.slice(space + 1) : ''
  if (version && program && supports(version)) {
    return { program, env: {}, source: 'system', version }
  }
  return {
    program: deps.execPath,
    env: deps.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    source: 'orca',
    version: deps.version
  }
}
