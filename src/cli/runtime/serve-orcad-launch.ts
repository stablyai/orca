/**
 * `orca serve` on this machine's orcad slot. Whether to (and the slot itself) is decided
 * app-side by `src/main/orcad/orcad-local-serve-selection.ts`; the CLI only asks and runs.
 */
import { dirname, join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import {
  ORCAD_LOCAL_SERVE_SELECTION_ENTRY,
  ORCAD_LOCAL_SERVE_SELECTION_FLAGS as FLAGS,
  parseServeRuntimeSelection,
  type ServeRuntimeSelection
} from '../../shared/orcad-local-serve-selection'
import type { ServeOrcaAppArgs } from './launch'
import { waitForRecipeJson } from './serve-recipe-json'
import { superviseForegroundServe } from './serve-update-supervisor'

type SupervisorArgs = Parameters<typeof superviseForegroundServe>[0]

/** A first run may download and verify the pinned Node; bound it well past that. */
const SELECTION_TIMEOUT_MS = 10 * 60_000

/** Asks the app's own entry, run on the app's executable as plain Node, which host to serve on. */
export async function resolveLocalServeRuntime(
  options: {
    executable: string
    appRoot: string
    userDataPath: string
    usesMacUpdateHandoff: boolean
  },
  run: typeof runProcess = runProcess
): Promise<ServeRuntimeSelection> {
  const entry = join(options.appRoot, 'out', 'main', `${ORCAD_LOCAL_SERVE_SELECTION_ENTRY}.js`)
  try {
    const result = await run({
      program: options.executable,
      args: [
        entry,
        FLAGS.userData,
        options.userDataPath,
        FLAGS.appRoot,
        options.appRoot,
        ...(options.usesMacUpdateHandoff ? [FLAGS.macUpdateHandoff] : [])
      ],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeoutMs: SELECTION_TIMEOUT_MS
    })
    return (
      parseServeRuntimeSelection(result.stdout) ?? {
        kind: 'electron',
        reason: `the app did not answer which serve host to use (exit ${String(result.code)})`
      }
    )
  } catch (error) {
    return {
      kind: 'electron',
      reason: `the app could not check orcad: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/** Electron serve binds every interface (`exposeNetworkByDefault`); orcad does it on request. */
export function serveWithOrcad(
  selection: Extract<ServeRuntimeSelection, { kind: 'orcad' }>,
  args: ServeOrcaAppArgs,
  userDataPath: string,
  spawnProcess: SupervisorArgs['spawnChild']
): Promise<number> {
  const childArgs = [selection.entry, ...orcadServeArgs(args)]
  const spawnOptions: SupervisorArgs['spawnOptions'] = {
    detached: args.recipeJson === true,
    cwd: dirname(selection.entry),
    stdio: args.recipeJson === true ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: {
      ...withoutElectronRunAsNode(process.env),
      // The desktop's profile: its instance lock makes the two refuse each other.
      ORCA_USER_DATA: userDataPath,
      ORCA_VERSION: selection.version
    }
  }
  const child = spawnProcess(selection.runtime, childArgs, spawnOptions)
  if (args.recipeJson) {
    return waitForRecipeJson(child)
  }
  return superviseForegroundServe({
    executable: selection.runtime,
    childArgs,
    spawnOptions,
    spawnChild: spawnProcess,
    child,
    handoffPath: null,
    expectedHandoff: null
  })
}

export function orcadServeArgs(args: ServeOrcaAppArgs): string[] {
  return [
    '--bind',
    '0.0.0.0',
    ...(args.json ? ['--json'] : []),
    ...(args.port ? ['--port', args.port] : []),
    ...(args.pairingAddress ? ['--pairing-address', args.pairingAddress] : []),
    ...(args.noPairing ? ['--no-pairing'] : []),
    ...(args.mobilePairing ? ['--mobile-pairing'] : []),
    ...(args.recipeJson && args.projectRoot
      ? ['--recipe-json', '--project-root', args.projectRoot]
      : [])
  ]
}

function withoutElectronRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  delete next.ELECTRON_RUN_AS_NODE
  return next
}
