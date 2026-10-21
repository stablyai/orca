/**
 * The Linux AppImage terminal daemon on the bundled Node inside an extracted copy of the AppImage
 * (the generation under `~/.cache/orca/appimage`, see appimage-extraction-cache.md). Nothing it
 * runs from lives on a FUSE mount, so no window's exit, logout or FUSE server can take its pages,
 * and the generation's lease and `/proc` residency keep pruners off it while it runs.
 *
 * The desktop never extracts on its own; CLI registration and `orca serve` do. Without a complete
 * copy for this exact release, the launch falls back to the AppImage's own mount and says why.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import { APPIMAGE_NODE_RUNTIME_SEGMENTS } from '../../shared/appimage-node-runtime'
import { resolveAppImageRuntimeIdentity } from '../appimage-runtime-identity'
import {
  isAppImageExtractionComplete,
  resolveAppImageExtractedRoot
} from '../cli/appimage-extracted-root'
import { removeAppImageRuntimeEnv } from '../pty/appimage-terminal-env'
import type { DurableDaemonScopeCommand } from './daemon-cgroup-scope'

export type AppImageGenerationDaemonLaunch = {
  generationRoot: string
  nodePath: string
  entryPath: string
  /** `$APPIMAGE/<entry>`: the identity own-mount daemons record, stable across mounts and copies. */
  identityPath: string
}

export type AppImageGenerationFallback =
  | 'no-extracted-copy'
  | 'no-bundled-node'
  | 'no-daemon-entry'
  | 'version-mismatch'

type ResolveInput = {
  entryPath: string
  appVersion: string
  environment?: NodeJS.ProcessEnv
  cacheRootPath?: string
}

/** Null when this is not a validated AppImage, so every other package keeps today's launch. */
export function resolveAppImageGenerationDaemonLaunch({
  entryPath,
  appVersion,
  environment = process.env,
  cacheRootPath
}: ResolveInput):
  | { launch: AppImageGenerationDaemonLaunch }
  | { fallback: AppImageGenerationFallback }
  | null {
  const appDir = environment.APPDIR
  const entryPathInAppDir = appDir ? relativePathInsideRoot(appDir, entryPath) : null
  if (!entryPathInAppDir) {
    return null
  }
  const identity = resolveAppImageRuntimeIdentity({ environment })
  if (!identity) {
    return null
  }
  const root = resolveAppImageExtractedRoot({ appImagePath: identity.appImagePath, cacheRootPath })
  if (!root || !isAppImageExtractionComplete(root)) {
    return { fallback: 'no-extracted-copy' }
  }
  const nodePath = join(root.rootPath, 'resources', ...APPIMAGE_NODE_RUNTIME_SEGMENTS)
  if (!existsSync(nodePath)) {
    return { fallback: 'no-bundled-node' }
  }
  const generationEntryPath = join(root.rootPath, entryPathInAppDir)
  if (!existsSync(generationEntryPath)) {
    return { fallback: 'no-daemon-entry' }
  }
  // Why: the copy is keyed by the file now at $APPIMAGE, which an update may already have replaced.
  if (readStampedVersion(join(generationEntryPath, '..', '..', 'package.json')) !== appVersion) {
    return { fallback: 'version-mismatch' }
  }
  return {
    launch: {
      generationRoot: root.rootPath,
      nodePath,
      entryPath: generationEntryPath,
      identityPath: join(identity.appImagePath, entryPathInAppDir)
    }
  }
}

function readStampedVersion(packageJsonPath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    return typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string'
      ? parsed.version
      : null
  } catch {
    return null
  }
}

/** The program/args/env replacing `execPath entry ...scriptArgs` for a generation launch. */
export function buildAppImageGenerationDaemonCommand(
  launch: AppImageGenerationDaemonLaunch,
  scriptArgs: string[],
  env: NodeJS.ProcessEnv
): DurableDaemonScopeCommand {
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      childEnv[key] = value
    }
  }
  // Why: nothing the daemon or its terminals inherit may point back into the window's mount.
  removeAppImageRuntimeEnv(childEnv)
  delete childEnv.ELECTRON_RUN_AS_NODE
  return { command: launch.nodePath, args: [launch.entryPath, ...scriptArgs], env: childEnv }
}
