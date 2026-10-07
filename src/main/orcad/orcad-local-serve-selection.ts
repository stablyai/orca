/**
 * Which host runs `orca serve`: orcad on this machine's packaged slot, or Electron `--serve`.
 * App-side on purpose: the CLI runs it through `orcad-local-serve-selection-entry.ts`, so the
 * CLI bundle never carries the materializers.
 *
 * orcad by default; `ORCA_SERVE_RUNTIME=electron` opts out. Anything that stops orcad from
 * serving this machine (no slot for the target, no pinned Node, a native module it cannot load,
 * a host or packaging path it does not cover yet) falls back to Electron with one stderr line
 * saying why. Everything this writes stays inside the desktop's userData (design D7): the slot
 * under `orcad-artifacts/`, assembled from the template inside the app bundle.
 */
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { NODE_RUNTIME_ASSETS, type ServerTarget } from '../../shared/node-runtime-pin'
import { ORCAD_VERSION_FILENAME, orcadNodeRuntimeRelativePath } from '../../shared/orcad-artifacts'
import {
  ORCAD_NATIVE_PREFLIGHT_FLAG,
  parseOrcadNativePreflightReport
} from '../../shared/orcad-native-preflight-report'
import {
  SERVE_RUNTIME_ELECTRON,
  SERVE_RUNTIME_ENV,
  type ServeRuntimeSelection
} from '../../shared/orcad-local-serve-selection'
import { resolveBundledOrcadRuntime } from './orcad-bundled-runtime'
import { detectNativeHostAbi, nativeSlotName } from './native-host-abi'
import { materializeOrcadArtifact } from '../ssh/orcad-artifact-materializer'
import { materializeCachedNodeRuntime } from '../ssh/pinned-runtime-materializer'

const NATIVE_PREFLIGHT_TIMEOUT_MS = 30_000

export type ServeRuntimeSelectionInput = {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  userDataPath: string
  templateDirs: readonly string[]
  hostTarget?: () => string
  materializeSlot?: typeof materializeOrcadArtifact
  materializeRuntime?: typeof materializeCachedNodeRuntime
  nativePreflight?: (runtime: string, entry: string) => Promise<string>
}

function isServerTarget(value: string): value is ServerTarget {
  return Object.keys(NODE_RUNTIME_ASSETS).includes(value)
}

function electron(reason: string): ServeRuntimeSelection {
  return { kind: 'electron', reason }
}

export async function selectServeRuntime(
  input: ServeRuntimeSelectionInput
): Promise<ServeRuntimeSelection> {
  const requested = input.env[SERVE_RUNTIME_ENV]
  if (requested === SERVE_RUNTIME_ELECTRON) {
    return { kind: 'electron', reason: null }
  }
  if (requested && requested !== 'orcad') {
    return electron(`${SERVE_RUNTIME_ENV}=${requested} is neither orcad nor electron`)
  }
  const target = (input.hostTarget ?? (() => nativeSlotName(detectNativeHostAbi())))()
  if (!isServerTarget(target)) {
    return electron(`no orcad build exists for this host (${target})`)
  }
  const templateDir = input.templateDirs.find((candidate) => existsSync(candidate))
  if (!templateDir) {
    return electron('this Orca install carries no orcad template')
  }
  const cacheRoot = join(input.userDataPath, 'orcad-artifacts')
  let slotDir: string
  try {
    slotDir = await (input.materializeSlot ?? materializeOrcadArtifact)(target, {
      templateDir,
      cacheRoot
    })
    await placeSlotRuntime(slotDir, target, cacheRoot, input.materializeRuntime)
  } catch (error) {
    return electron(`the orcad slot for ${target} could not be prepared: ${errorText(error)}`)
  }
  let runtime: string | null
  try {
    runtime = resolveBundledOrcadRuntime(slotDir)
  } catch (error) {
    return electron(`the orcad slot is incomplete: ${errorText(error)}`)
  }
  if (!runtime) {
    return electron('the orcad slot names no pinned runtime')
  }
  const entry = join(slotDir, 'orcad.js')
  const report = parseOrcadNativePreflightReport(
    await (input.nativePreflight ?? runNativePreflight)(runtime, entry).catch(() => '')
  )
  if (!report) {
    return electron('orcad did not answer its native preflight')
  }
  if (report.status === 'blocked' || report.status === 'degraded') {
    return electron(
      `orcad cannot run terminals here (${report.status}: ${report.reason ?? 'unknown'})`
    )
  }
  return {
    kind: 'orcad',
    runtime,
    entry,
    version: readFileSync(join(slotDir, ORCAD_VERSION_FILENAME), 'utf8').trim()
  }
}

/** The slot references its runtime beside it; the cached pinned Node is linked into place. */
async function placeSlotRuntime(
  slotDir: string,
  target: ServerTarget,
  cacheRoot: string,
  materializeRuntime: typeof materializeCachedNodeRuntime = materializeCachedNodeRuntime
): Promise<void> {
  const destination = join(
    slotDir,
    ...orcadNodeRuntimeRelativePath(target, NODE_RUNTIME_ASSETS[target].executableSha256)
  )
  if (existsSync(destination)) {
    return
  }
  const cached = await materializeRuntime(target, cacheRoot, { fetcher: fetch })
  mkdirSync(dirname(destination), { recursive: true })
  try {
    linkSync(cached, destination)
  } catch {
    copyFileSync(cached, destination)
    chmodSync(destination, 0o755)
  }
}

async function runNativePreflight(runtime: string, entry: string): Promise<string> {
  const result = await runProcess({
    program: runtime,
    args: [entry, ORCAD_NATIVE_PREFLIGHT_FLAG],
    timeoutMs: NATIVE_PREFLIGHT_TIMEOUT_MS
  })
  return result.stdout
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
