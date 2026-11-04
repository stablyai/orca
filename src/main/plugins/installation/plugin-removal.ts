import { realpath, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isQualifiedPluginKey } from '../../../shared/plugins/manifest/plugin-manifest'
import { removePluginLock } from '../../../shared/plugins/installation/plugin-install-lockfile'
import { readPluginLockfile, writePluginLockfile } from './plugin-install-lockfile-store'
import { serializePluginMutation } from './plugin-mutation-queue'

export async function removeInstalledPlugin(input: {
  pluginsDir: string
  pluginsDataDir: string
  pluginKey: string
}): Promise<void> {
  await serializePluginMutation(input.pluginsDir, async () => {
    if (!isQualifiedPluginKey(input.pluginKey)) {
      throw new Error(`invalid qualified plugin key: ${input.pluginKey}`)
    }
    const lock = await readPluginLockfile(input.pluginsDir)
    if (lock.plugins[input.pluginKey]?.source.kind === 'bundled') {
      throw new Error(`cannot remove protected plugin ${input.pluginKey}`)
    }
    await removePluginFiles(input)
  })
}

/** Removes a bundled install this Orca release no longer ships; any other source is left alone. */
export async function retireBundledPlugin(input: {
  pluginsDir: string
  pluginsDataDir: string
  pluginKey: string
}): Promise<boolean> {
  return serializePluginMutation(input.pluginsDir, async () => {
    if (!isQualifiedPluginKey(input.pluginKey)) {
      throw new Error(`invalid qualified plugin key: ${input.pluginKey}`)
    }
    const source = (await readPluginLockfile(input.pluginsDir)).plugins[input.pluginKey]?.source
    if (source?.kind !== 'bundled' || source.bundleId !== input.pluginKey) {
      return false
    }
    await removePluginFiles(input)
    return true
  })
}

async function removePluginFiles(input: {
  pluginsDir: string
  pluginsDataDir: string
  pluginKey: string
}): Promise<void> {
  await removeResolvedPluginDirectory(input.pluginsDir, input.pluginKey)
  await removeResolvedPluginDirectory(input.pluginsDataDir, input.pluginKey)
  await writePluginLockfile(
    input.pluginsDir,
    removePluginLock(await readPluginLockfile(input.pluginsDir), input.pluginKey)
  )
}

async function removeResolvedPluginDirectory(rootDir: string, pluginKey: string): Promise<void> {
  const rootReal = await realpathIfPresent(resolve(rootDir))
  const targetReal = rootReal ? await realpathIfPresent(resolve(rootDir, pluginKey)) : null
  if (!rootReal || !targetReal) {
    return
  }
  const fromRoot = relative(rootReal, targetReal)
  if (
    fromRoot.length === 0 ||
    isAbsolute(fromRoot) ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`)
  ) {
    throw new Error(`refusing to remove plugin path outside ${rootReal}`)
  }
  await rm(resolve(rootDir, pluginKey), { recursive: true, force: true })
}

async function realpathIfPresent(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}
