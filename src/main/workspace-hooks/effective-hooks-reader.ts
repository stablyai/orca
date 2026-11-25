import { readFile } from 'node:fs/promises'
import { parseOrcaYaml } from '../../shared/workspace-setup/orca-yaml'
import type { OrcaHooks } from '../../shared/workspace-setup/orca-yaml-hook-types'
import type { WorkspaceHookOwner } from '../../shared/workspace-setup/hooks/workspace-hook-owner'
import { getEffectiveHooksFromConfig } from './effective-hook-config'
import { join } from 'node:path'
import { windowsFsPath } from '../wsl/filesystem/wsl-unc-drive-fs-path'

async function readHookConfig(path: string): Promise<OrcaHooks | null> {
  try {
    return parseOrcaYaml(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

export async function getEffectiveHooksAsync(owner: WorkspaceHookOwner, path = owner.path) {
  return getEffectiveHooksFromConfig(
    owner,
    await readHookConfig(windowsFsPath(join(path, 'orca.yaml')))
  )
}

/** One preview shares file observations; automatic removal uses a fresh reader instead. */
export function createEffectiveHooksReader(): typeof getEffectiveHooksAsync {
  const configs = new Map<string, Promise<OrcaHooks | null>>()
  return async (owner, path = owner.path) => {
    const key = windowsFsPath(join(path, 'orca.yaml'))
    let config = configs.get(key)
    if (!config) {
      config = readHookConfig(key)
      configs.set(key, config)
    }
    return getEffectiveHooksFromConfig(owner, await config)
  }
}
