/**
 * Gather the evidence a node-pty spawn failure needs, on the host that failed.
 *
 * Three sources, because no single one is sufficient:
 *
 *  1. What is on disk where node-pty's loader looks, and what node-gyp recorded it was
 *     configured for (`build/config.gypi`). This answers "wrong ABI / wrong arch" even
 *     when the loader said nothing useful, and it is the only source available when the
 *     binding is absent entirely.
 *  2. The dynamic loader's own words, recovered by dlopen'ing the file node-pty would
 *     have opened. node-pty's loader rethrows only its LAST attempt, so the real message
 *     is otherwise destroyed before the relay sees it. This runs in a CHILD process: a
 *     binding that aborts inside the loader would take the relay down with it, and a
 *     relay that dies is a reconnect loop rather than an error message.
 *  3. The host's C/C++ toolchain, but only when nothing was compiled — "install
 *     build-essential" is the right answer for a compile that never ran, and noise for a
 *     binary that exists and is simply wrong.
 *
 * Every step is best-effort and failure-tolerant: whatever cannot be established is
 * reported as unestablished rather than guessed (docs/reference/ssh-execution-boundary.md).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { release } from 'node:os'
import process from 'node:process'
import { runProcess } from '../shared/child-process/run-process'
import {
  buildToolchainProbeCommand,
  parseBuildToolchainProbe,
  type BuildToolchainStatus
} from '../main/ssh/build-toolchain-diagnosis'
import { detectNativeHostAbi } from '../main/orcad/native-host-abi'
import {
  buildNodePtyLoadProbeScript,
  readNodePtyProbeOutcome
} from '../main/orcad/node-pty-precondition'
import {
  diagnoseNodePtyUnavailable,
  type NodePtyBindingSurvey,
  type NodePtyDiagnosisInput,
  type NodePtyUnavailableDiagnosis,
  type NodePtyUnavailableHost
} from './node-pty-unavailable-diagnosis'

/** Bounded so a wedged loader delays one spawn rejection, not the relay. */
const LOAD_PROBE_TIMEOUT_MS = 10_000
const TOOLCHAIN_PROBE_TIMEOUT_MS = 5_000

/** node-pty's own search order, so the file surveyed is the file it would have opened. */
function bindingSearchDirs(platform: NodeJS.Platform, arch: string): string[] {
  return ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`]
}

/** Windows defers to conpty.node on builds that have ConPTY, exactly as node-pty picks it. */
function bindingBaseName(platform: NodeJS.Platform): string {
  if (platform !== 'win32') {
    return 'pty'
  }
  return Number(release().split('.')[2]) >= 18309 ? 'conpty' : 'pty'
}

export function surveyNodePtyBinding(
  nodePtyDir: string,
  host: Pick<NodePtyUnavailableHost, 'platform' | 'arch'>
): NodePtyBindingSurvey | null {
  const name = bindingBaseName(host.platform)
  const searched = bindingSearchDirs(host.platform, host.arch)
  let bindingPath: string | null = null
  try {
    for (const dir of searched) {
      for (const root of [nodePtyDir, join(nodePtyDir, 'lib')]) {
        const candidate = join(root, dir, `${name}.node`)
        if (existsSync(candidate)) {
          bindingPath = candidate
          break
        }
      }
      if (bindingPath) {
        break
      }
    }
  } catch {
    return null
  }
  const built = readNodeGypBuildRecord(nodePtyDir)
  return {
    moduleDir: nodePtyDir,
    bindingPath,
    searched,
    builtNodeAbi: built.nodeAbi,
    builtArch: built.arch
  }
}

/**
 * What node-gyp configured this build for.
 *
 * Why this file and not the binary: `build/config.gypi` is written by `node-gyp
 * configure` from the headers it downloaded, so it names the ABI and architecture the
 * `.node` was compiled against without parsing ELF. It survives a build that later
 * failed, which is the case where the loader has nothing to say.
 */
export function readNodeGypBuildRecord(nodePtyDir: string): {
  nodeAbi: string | null
  arch: string | null
} {
  try {
    const raw = readFileSync(join(nodePtyDir, 'build', 'config.gypi'), 'utf8')
    // node-gyp prefixes the JSON with `# Do not edit…` comment lines.
    const body = raw
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    const variables = (JSON.parse(body) as { variables?: Record<string, unknown> }).variables
    const nodeAbi = variables?.node_module_version
    const arch = variables?.target_arch
    return {
      nodeAbi: nodeAbi === undefined || nodeAbi === null ? null : String(nodeAbi),
      arch: typeof arch === 'string' && arch.length > 0 ? arch : null
    }
  } catch {
    return { nodeAbi: null, arch: null }
  }
}

/**
 * The loader's verdict on the binding, recovered out of process.
 *
 * Returns the pieces `diagnoseNodePtyUnavailable` reads; a probe that could not run
 * answers `unverifiableBecause` rather than a cause, because it established nothing.
 */
async function probeNodePtyLoader(
  nodePtyDir: string
): Promise<Pick<NodePtyDiagnosisInput, 'loaderError' | 'probeSignal' | 'unverifiableBecause'>> {
  let result
  try {
    result = await runProcess({
      program: process.execPath,
      args: ['-e', buildNodePtyLoadProbeScript(nodePtyDir)],
      timeoutMs: LOAD_PROBE_TIMEOUT_MS
    })
  } catch (error) {
    return {
      unverifiableBecause: `the node-pty load probe could not be started (${(error as Error).message})`
    }
  }
  const outcome = readNodePtyProbeOutcome(result)
  switch (outcome.kind) {
    case 'loaderError':
      return { loaderError: outcome.message }
    case 'signalled':
      return { probeSignal: outcome.signal }
    case 'unanswered':
      return { unverifiableBecause: outcome.detail }
    // `loaded` here means the binding is fine under plain Node while the relay's own
    // require failed — real, and not something the loader can explain. `noBinary` and
    // `unexplained` are both better answered by the on-disk survey than by the probe.
    case 'loaded':
    case 'noBinary':
    case 'unexplained':
      return {}
  }
}

/** node-pty has no Linux prebuild, so only there does a missing toolchain explain anything. */
async function probeRelayBuildToolchain(
  platform: NodeJS.Platform
): Promise<BuildToolchainStatus | null> {
  if (platform !== 'linux') {
    return null
  }
  try {
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', buildToolchainProbeCommand()],
      timeoutMs: TOOLCHAIN_PROBE_TIMEOUT_MS
    })
    return result.timedOut ? null : parseBuildToolchainProbe(result.stdout)
  } catch {
    return null
  }
}

function readErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message
  }
  return typeof error === 'string' && error.length > 0 ? error : null
}

/**
 * Everything above, in the order that makes each step's cost conditional on the previous
 * one's answer. Called only on the failure path, so a spawn that works pays nothing.
 */
export async function collectNodePtyUnavailableDiagnosis(options: {
  nodePtyDir: string | null
  error?: unknown
}): Promise<NodePtyUnavailableDiagnosis> {
  const abi = detectNativeHostAbi()
  const host: NodePtyUnavailableHost = { ...abi, nodeVersion: process.version }
  const requireError = readErrorMessage(options.error)
  if (!options.nodePtyDir) {
    return diagnoseNodePtyUnavailable({
      host,
      survey: null,
      requireError,
      unverifiableBecause: 'the relay could not locate its node-pty install directory'
    })
  }
  const survey = surveyNodePtyBinding(options.nodePtyDir, host)
  const probed = survey?.bindingPath ? await probeNodePtyLoader(options.nodePtyDir) : {}
  const toolchain =
    survey && !survey.bindingPath ? await probeRelayBuildToolchain(host.platform) : null
  return diagnoseNodePtyUnavailable({ ...probed, host, survey, requireError, toolchain })
}
