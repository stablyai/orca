/**
 * `orca serve` on this machine's orcad slot. Whether to (and the slot itself) is decided
 * app-side by `src/main/orcad/orcad-local-serve-selection.ts`; the CLI only asks and runs.
 */
import { dirname, join } from 'node:path'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import {
  ORCAD_LOCAL_SERVE_SELECTION_ENTRY,
  ORCAD_LOCAL_SERVE_SELECTION_FLAGS as FLAGS,
  parseServeRuntimeSelection,
  type ServeRuntimeSelection
} from '../../shared/orcad-local-serve-selection'
import { waitForRecipeJson } from './serve-recipe-json'
import { superviseForegroundServe } from './serve-update-supervisor'

type SupervisorArgs = Parameters<typeof superviseForegroundServe>[0]

export type ServeOrcaAppArgs = {
  json?: boolean
  port?: string | null
  pairingAddress?: string | null
  noPairing?: boolean
  mobilePairing?: boolean
  grantDesktopControl?: boolean
  recipeJson?: boolean
  projectRoot?: string | null
}

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
  // Why: only packaged macOS serve can take a remote app update, through Electron's updater and
  // this CLI's supervisor; orcad has no updater, so switching would drop that.
  if (options.usesMacUpdateHandoff) {
    return {
      kind: 'electron',
      reason:
        'packaged macOS serve stays on Electron so paired clients can still update it (orcad has no app updater)'
    }
  }
  const entry = join(options.appRoot, 'out', 'main', `${ORCAD_LOCAL_SERVE_SELECTION_ENTRY}.js`)
  try {
    const result = await run({
      program: options.executable,
      args: [entry, FLAGS.userData, options.userDataPath, FLAGS.appRoot, options.appRoot],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      // Why inherit stderr: a first run may download the pinned Node, and that progress is the
      // only sign `orca serve` is not hung.
      stdio: ['ignore', 'pipe', 'inherit'],
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

/** The shared spawn chokepoint (windowsHide, no shell) in the supervisor's spawn shape. */
const spawnThroughChokepoint: SupervisorArgs['spawnChild'] = (program, args, options) =>
  spawnProcess({
    program,
    args,
    cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
    env: options.env,
    stdio: options.stdio,
    detached: options.detached
  })

/** Electron serve binds every interface (`exposeNetworkByDefault`); orcad does it on request. */
export function serveWithOrcad(
  selection: Extract<ServeRuntimeSelection, { kind: 'orcad' }>,
  args: ServeOrcaAppArgs,
  userDataPath: string,
  /** The caller's environment without `ELECTRON_RUN_AS_NODE`. */
  baseEnv: NodeJS.ProcessEnv,
  spawnChild: SupervisorArgs['spawnChild'] = spawnThroughChokepoint
): Promise<number> {
  const childArgs = [selection.entry, ...orcadServeArgs(args)]
  const spawnOptions: SupervisorArgs['spawnOptions'] = {
    detached: args.recipeJson === true,
    cwd: dirname(selection.entry),
    stdio: args.recipeJson === true ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: {
      ...baseEnv,
      // The desktop's profile: its instance lock makes the two refuse each other.
      ORCA_USER_DATA: userDataPath,
      ORCA_VERSION: selection.version
    }
  }
  const child = spawnChild(selection.runtime, childArgs, spawnOptions)
  if (args.recipeJson) {
    return waitForRecipeJson(child)
  }
  return superviseForegroundServe({
    executable: selection.runtime,
    childArgs,
    spawnOptions,
    spawnChild,
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
    ...(args.grantDesktopControl ? ['--grant-desktop-control'] : []),
    ...(args.recipeJson && args.projectRoot
      ? ['--recipe-json', '--project-root', args.projectRoot]
      : [])
  ]
}
