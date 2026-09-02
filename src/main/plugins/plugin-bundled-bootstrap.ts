import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { isQualifiedPluginKey } from '../../shared/plugins/plugin-manifest'
import { pluginRelativeDirectorySchema } from '../../shared/plugins/plugin-manifest-fields'
import { isOfficialPluginIdentity } from '../../shared/plugins/plugin-marketplace'
import { getUserPluginsDir } from './plugin-discovery'
import { installBundledPlugin, readPluginLockfile } from './plugin-install'
import { inspectPluginInstallTree } from './plugin-install-staging'
import { readPluginCurrentPointer } from './plugin-current-pointer'
import { hashPluginTree } from './plugin-content-hash'

export const BUNDLED_PLUGIN_INDEX_FILENAME = 'bundled-plugins.json'
const BUNDLED_PLUGIN_INDEX_MAX_BYTES = 64 * 1024

const bundledPluginIndexSchema = z
  .object({
    version: z.literal(1),
    plugins: z
      .array(
        z
          .object({
            pluginKey: z
              .string()
              .refine(isQualifiedPluginKey, 'invalid qualified plugin identity')
              .refine(isOfficialPluginIdentity, 'bundled plugins must use an official identity'),
            path: pluginRelativeDirectorySchema,
            contentHash: z.string().regex(/^[0-9a-f]{64}$/)
          })
          .strict()
      )
      .max(32)
  })
  .strict()
  .superRefine((index, ctx) => {
    const keys = new Set<string>()
    for (const [entryIndex, plugin] of index.plugins.entries()) {
      if (keys.has(plugin.pluginKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['plugins', entryIndex, 'pluginKey'],
          message: 'duplicate bundled plugin identity'
        })
      }
      keys.add(plugin.pluginKey)
    }
  })

export type PluginBundledBootstrapResult = {
  installed: string[]
  unchanged: string[]
  errors: { pluginKey: string; error: string }[]
}

export function resolveBundledPluginRoot(options: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, 'plugins', 'launch')
    : join(options.appPath, 'resources', 'plugins', 'launch')
}

async function readBundledPluginIndex(
  root: string
): Promise<z.infer<typeof bundledPluginIndexSchema>> {
  const indexPath = join(root, BUNDLED_PLUGIN_INDEX_FILENAME)
  const metadata = await stat(indexPath)
  if (!metadata.isFile() || metadata.size > BUNDLED_PLUGIN_INDEX_MAX_BYTES) {
    throw new Error(`bundled plugin index exceeds ${BUNDLED_PLUGIN_INDEX_MAX_BYTES} bytes`)
  }
  return bundledPluginIndexSchema.parse(JSON.parse(await readFile(indexPath, 'utf8')))
}

async function resolveBundlePath(root: string, path: string): Promise<string> {
  const [resolvedRoot, resolvedPath] = await Promise.all([
    realpath(root),
    realpath(join(root, path))
  ])
  const fromRoot = relative(resolvedRoot, resolvedPath)
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('bundled plugin path escapes the resource root')
  }
  return resolvedPath
}

async function bundledInstallIsIntact(
  pluginsDir: string,
  pluginKey: string,
  contentHash: string
): Promise<boolean> {
  const pluginDir = join(pluginsDir, pluginKey)
  if ((await readPluginCurrentPointer(pluginDir).catch(() => null)) !== contentHash) {
    return false
  }
  const hashed = await hashPluginTree(join(pluginDir, contentHash))
  return hashed.ok && hashed.hash === contentHash
}

export async function bootstrapBundledPlugins(options: {
  root: string
  userDataPath: string
  hostVersion: string
  blockedPluginReason?: (pluginKey: string) => string | null
}): Promise<PluginBundledBootstrapResult> {
  const index = await readBundledPluginIndex(options.root)
  const pluginsDir = getUserPluginsDir(options.userDataPath)
  const lock = await readPluginLockfile(pluginsDir)
  const result: PluginBundledBootstrapResult = { installed: [], unchanged: [], errors: [] }
  for (const entry of index.plugins) {
    const locked = lock.plugins[entry.pluginKey]
    if (
      locked?.source.kind === 'bundled' &&
      locked.source.bundleId === entry.pluginKey &&
      locked.contentHash === entry.contentHash &&
      (await bundledInstallIsIntact(pluginsDir, entry.pluginKey, entry.contentHash))
    ) {
      result.unchanged.push(entry.pluginKey)
      continue
    }
    try {
      const sourcePath = await resolveBundlePath(options.root, entry.path)
      const inspection = await inspectPluginInstallTree({
        rootDir: sourcePath,
        hostVersion: options.hostVersion,
        expectedPluginKey: entry.pluginKey
      })
      if (!inspection.ok) {
        throw new Error(inspection.error)
      }
      if (inspection.contentHash !== entry.contentHash) {
        throw new Error('bundled plugin content does not match its release index')
      }
      const installed = await installBundledPlugin({
        pluginsDir,
        sourcePath,
        hostVersion: options.hostVersion,
        expectedPluginKey: entry.pluginKey,
        blockedPluginReason: options.blockedPluginReason
      })
      if (!installed.ok) {
        throw new Error(installed.error)
      }
      result.installed.push(entry.pluginKey)
    } catch (error) {
      result.errors.push({
        pluginKey: entry.pluginKey,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}
