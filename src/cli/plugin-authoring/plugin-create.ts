import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parsePluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_TEMPLATE_NAMES, type PluginTemplateName } from './plugin-template-names'
import { renderPluginTemplate } from './plugin-templates'

export type PluginCreateResult = {
  path: string
  template: PluginTemplateName
  pluginKey: string
  files: string[]
}

export class PluginCreateError extends Error {}

/** A manifest id from a folder name: lowercase words joined by `-`. */
export function pluginIdFromFolder(folder: string): string {
  return basename(folder)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function titleFromId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')
}

function assertEmptyFolder(dir: string): void {
  if (!existsSync(dir)) {
    return
  }
  if (!statSync(dir).isDirectory()) {
    throw new PluginCreateError(`${dir} exists and is not a folder`)
  }
  // Why .git allowed: authors often `git init` first; nothing else is overwritten.
  const entries = readdirSync(dir).filter((entry) => entry !== '.git')
  if (entries.length > 0) {
    throw new PluginCreateError(`${dir} is not empty; choose a new or empty folder`)
  }
}

/** Writes a template into an empty folder. Never runs Git, installs dependencies or executes code. */
export async function createPluginFromTemplate(input: {
  dir: string
  template: PluginTemplateName
  publisher?: string
  id?: string
  name?: string
}): Promise<PluginCreateResult> {
  const dir = resolve(input.dir)
  const id = input.id ?? pluginIdFromFolder(dir)
  const publisher = input.publisher ?? 'your-github-user'
  const name = input.name ?? (titleFromId(id) || id)
  const template = renderPluginTemplate(input.template, { publisher, id, name })
  const manifest = parsePluginManifest(JSON.parse(template.files['orca-plugin.json']))
  if (!manifest.ok) {
    throw new PluginCreateError(
      `cannot create ${publisher}.${id}: ${manifest.error}. Pass --id and --publisher using lowercase letters, numbers and dashes.`
    )
  }
  assertEmptyFolder(dir)
  const files = Object.keys(template.files).sort()
  for (const file of files) {
    const target = join(dir, ...file.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, template.files[file], { flag: 'wx' })
  }
  return { path: dir, template: input.template, pluginKey: `${publisher}.${id}`, files }
}

export const PLUGIN_TEMPLATE_LIST = PLUGIN_TEMPLATE_NAMES.map((name) => ({
  name,
  description: renderPluginTemplate(name, { publisher: 'p', id: 'x', name: 'X' }).description
}))
