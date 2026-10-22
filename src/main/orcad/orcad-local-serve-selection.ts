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
import { runProcess } from '@orca/process-host'
import { NODE_RUNTIME_ASSETS, type ServerTarget } from '../../shared/node-runtime-pin'
import {
  ORCAD_SERVER_ENTRY_FILENAME,
  ORCAD_VERSION_FILENAME,
  orcadNodeRuntimeRelativePath
} from '../../shared/orcad-artifacts'
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
import { materializeOrcadArtifact } from './orcad-artifact-materializer'
import { materializeCachedNodeRuntime } from '../node-runtime/pinned-runtime-materializer'
import {
  copyVerifiedAppImageNodeRuntime,
  type AppImageNodeRuntime
} from '../node-runtime/appimage-bundled-node-runtime'
import { serveProfileHasSshTargets } from './serve-profile-ssh-targets'
import { errorMessage } from '../../shared/error-message'

const NATIVE_PREFLIGHT_TIMEOUT_MS = 30_000

export type ServeRuntimeSelectionInput = {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  userDataPath: string
  templateDirs: readonly string[]
  hostTarget?: () => string
  materializeSlot?: typeof materializeOrcadArtifact
  materializeRuntime?: typeof materializeCachedNodeRuntime
  /** The pinned Node an AppImage carries; the slot uses it before trying a download. */
  bundledNodeRuntime?: AppImageNodeRuntime | null
  nativePreflight?: (runtime: string, entry: string) => Promise<string>
  profileHasSshTargets?: (userDataPath: string) => boolean
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
  // Why: orcad has no SSH connection stack yet, so a default serve on it would list no targets
  // and fail every connect (#25886, #8489). An explicit ORCA_SERVE_RUNTIME=orcad keeps orcad.
  const sshReason = requested ? null : profileSshReason(input)
  if (sshReason) {
    return electron(sshReason)
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
    await placeSlotRuntime(slotDir, target, cacheRoot, input)
  } catch (error) {
    return electron(`the orcad slot for ${target} could not be prepared: ${errorMessage(error)}`)
  }
  let runtime: string | null
  try {
    runtime = resolveBundledOrcadRuntime(slotDir)
  } catch (error) {
    return electron(`the orcad slot is incomplete: ${errorMessage(error)}`)
  }
  if (!runtime) {
    return electron('the orcad slot names no pinned runtime')
  }
  const entry = join(slotDir, ORCAD_SERVER_ENTRY_FILENAME)
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

/** Why this profile must serve on Electron for SSH, or null when it provably has no targets. */
function profileSshReason(input: ServeRuntimeSelectionInput): string | null {
  try {
    return (input.profileHasSshTargets ?? serveProfileHasSshTargets)(input.userDataPath)
      ? 'this profile has SSH targets, which orcad cannot serve yet'
      : null
  } catch (error) {
    // Why: fail closed. The read-only probe rejects profiles the serve host would still migrate
    // (an older schema), and guessing "no SSH" there leaves saved targets unreachable.
    return `could not tell whether this profile has SSH targets, which orcad cannot serve yet (${errorMessage(error)})`
  }
}

/** The slot references its runtime beside it: the AppImage's own copy, else the cached download. */
async function placeSlotRuntime(
  slotDir: string,
  target: ServerTarget,
  cacheRoot: string,
  {
    materializeRuntime = materializeCachedNodeRuntime,
    bundledNodeRuntime
  }: Pick<ServeRuntimeSelectionInput, 'materializeRuntime' | 'bundledNodeRuntime'>
): Promise<void> {
  const destination = join(
    slotDir,
    ...orcadNodeRuntimeRelativePath(target, NODE_RUNTIME_ASSETS[target].executableSha256)
  )
  if (existsSync(destination)) {
    return
  }
  if (bundledNodeRuntime?.target === target) {
    try {
      await copyVerifiedAppImageNodeRuntime(bundledNodeRuntime, destination)
      return
    } catch (error) {
      console.error(`orca serve: not using the bundled Node (${errorMessage(error)})`)
    }
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
