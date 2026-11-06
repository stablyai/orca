import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  APPIMAGE_NODE_RUNTIME_SEGMENTS,
  appImageNodeRuntimeTarget
} from '../../shared/appimage-node-runtime'
import { NODE_RUNTIME_ASSETS, type ServerTarget } from '../../shared/node-runtime-pin'
import { verifyFileSha256 } from './pinned-runtime-materializer'

export type AppImageNodeRuntime = {
  path: string
  target: ServerTarget
  executableSha256: string
}

export function findAppImageNodeRuntime(
  resourcesPath: string | undefined,
  arch: string = process.arch,
  platform: NodeJS.Platform = process.platform
): AppImageNodeRuntime | null {
  const target = appImageNodeRuntimeTarget(arch)
  if (platform !== 'linux' || !resourcesPath || !target) {
    return null
  }
  const path = join(resourcesPath, ...APPIMAGE_NODE_RUNTIME_SEGMENTS)
  return existsSync(path)
    ? { path, target, executableSha256: NODE_RUNTIME_ASSETS[target].executableSha256 }
    : null
}

/** Publish copied bytes only after verifying the pin. */
export async function copyVerifiedAppImageNodeRuntime(
  runtime: AppImageNodeRuntime,
  destination: string
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  const staging = `${destination}.copy-${process.pid}-${randomUUID()}`
  try {
    await copyFile(runtime.path, staging)
    await verifyFileSha256(staging, runtime.executableSha256, 'bundled Node')
    await chmod(staging, 0o755)
    await rename(staging, destination)
  } finally {
    await rm(staging, { force: true })
  }
}
