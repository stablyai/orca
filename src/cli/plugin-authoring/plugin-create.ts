import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parsePluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import { pluginDisplayNameFromId } from './plugin-display-name'
import { PLUGIN_TEMPLATE_NAMES, type PluginTemplateName } from './plugin-template-names'
import { pluginTemplateKey } from './plugin-template-files'
import { renderPluginTemplate } from './plugin-templates'
import { writePluginTypeFiles } from './plugin-type-files'

export type PluginCreateResult = {
  path: string
  template: PluginTemplateName
  pluginKey: string
  files: string[]
  /** Generated, gitignored typings (`.orca/types`), for templates written in TypeScript. */
  typeFiles: string[]
}

export class PluginCreateError extends Error {}

/** A manifest id from a folder name: lowercase words joined by `-`. */
export function pluginIdFromFolder(folder: string): string {
  return basename(folder)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
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
  const name = input.name ?? (pluginDisplayNameFromId(id) || id)
  const templateInput = { publisher: input.publisher, id, name }
  const pluginKey = pluginTemplateKey(templateInput)
  const template = renderPluginTemplate(input.template, templateInput)
  const manifest = parsePluginManifest(JSON.parse(template.files['orca-plugin.json']))
  if (!manifest.ok) {
    throw new PluginCreateError(
      `cannot create ${pluginKey}: ${manifest.error}. Pass --id (and --publisher, if set) using lowercase letters, numbers and dashes.`
    )
  }
  assertEmptyFolder(dir)
  const files = Object.keys(template.files).sort()
  for (const file of files) {
    const target = join(dir, ...file.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, template.files[file], { flag: 'wx' })
  }
  const typeFiles = template.files['tsconfig.json'] ? await writePluginTypeFiles(dir) : []
  return { path: dir, template: input.template, pluginKey, files, typeFiles }
}

export const PLUGIN_TEMPLATE_LIST = PLUGIN_TEMPLATE_NAMES.map((name) => ({
  name,
  description: renderPluginTemplate(name, { id: 'x', name: 'X' }).description
}))
