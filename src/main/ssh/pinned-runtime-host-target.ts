/**
 * Which of Orca's pinned Node runtimes a host can run, by glibc alone: the host target's own, a
 * compat runtime below the default's glibc floor, or none.
 */
import {
  COMPAT_SERVER_TARGET_BASES,
  isCompatServerTarget,
  pinnedNodeRuntimeAsset,
  type CompatServerTarget,
  type NodeRuntimeTarget,
  type ServerTarget
} from '../../shared/node-runtime-pin'
import type { GlibcVersion } from './orcad-deployment-target'

/** Official linux builds of the pinned Node need glibc 2.28. */
export const PINNED_NODE_GLIBC_FLOOR: GlibcVersion = { major: 2, minor: 28 }

type CompatNodeRuntime = {
  /** The pinned compat runtime and orcad slot it runs (NODE_RUNTIME_COMPAT_ASSETS). */
  runtimeTarget: CompatServerTarget
  /** The host target this runtime serves, e.g. linux-x64-glibc for a glibc 2.17 build. */
  hostTarget: ServerTarget
  glibcFloor: GlibcVersion
}

const COMPAT_NODE_RUNTIMES: readonly CompatNodeRuntime[] = [
  {
    runtimeTarget: 'linux-x64-glibc217',
    hostTarget: COMPAT_SERVER_TARGET_BASES['linux-x64-glibc217'],
    glibcFloor: { major: 2, minor: 17 }
  }
]

export function isGlibcBelow(version: GlibcVersion, floor: GlibcVersion): boolean {
  return (
    version.major < floor.major || (version.major === floor.major && version.minor < floor.minor)
  )
}

/** Null when no runtime serves the host; an unreadable glibc keeps the host target. */
export function pinnedRuntimeTargetForHost(facts: {
  target: ServerTarget
  glibc: GlibcVersion | null
}): NodeRuntimeTarget | null {
  const { glibc } = facts
  if (glibc === null || !isGlibcBelow(glibc, PINNED_NODE_GLIBC_FLOOR)) {
    return facts.target
  }
  const compat = COMPAT_NODE_RUNTIMES.find(
    (runtime) => runtime.hostTarget === facts.target && !isGlibcBelow(glibc, runtime.glibcFloor)
  )
  return compat?.runtimeTarget ?? null
}

/**
 * executableSha256 of every runtime the host store keeps pinned for `target`: the default runtime
 * and its compat ones, so GC never collects a runtime another slot on the host still runs.
 */
export function nodeRuntimeStorePins(target: NodeRuntimeTarget): string[] {
  const hostTarget = isCompatServerTarget(target) ? COMPAT_SERVER_TARGET_BASES[target] : target
  const targets = [
    hostTarget,
    ...COMPAT_NODE_RUNTIMES.filter((runtime) => runtime.hostTarget === hostTarget).map(
      (runtime) => runtime.runtimeTarget
    )
  ]
  return [...new Set(targets.map((pin) => pinnedNodeRuntimeAsset(pin).executableSha256))]
}
