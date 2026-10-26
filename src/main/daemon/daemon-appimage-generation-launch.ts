// Prefer an extracted generation: FUSE teardown cannot invalidate its mapped daemon pages.
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
  /** Mount-independent identity shared with own-mount daemons. */
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

/** Null outside validated AppImages; fallback reasons identify unavailable generation launches. */
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
  // Updates can replace the file at APPIMAGE before this launch resolves its extracted generation.
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
  // Do not let the daemon or its terminals inherit paths into the window's FUSE mount.
  removeAppImageRuntimeEnv(childEnv)
  delete childEnv.ELECTRON_RUN_AS_NODE
  return { command: launch.nodePath, args: [launch.entryPath, ...scriptArgs], env: childEnv }
}
