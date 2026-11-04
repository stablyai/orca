import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

export type BrowserExtensionManifestSummary = {
  name: string
  version: string
  iconPath: string | null
  permissions: string[]
  hostPermissions: string[]
  optionsPage: string | null
}

const ICON_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}
const MAX_ICON_BYTES = 512 * 1024
const PREFERRED_ICON_SIZE = 128

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
}

function isHostPermission(permission: string): boolean {
  return permission === '<all_urls>' || permission.includes('://')
}

/** Resolves only paths that stay inside the extension folder. */
export function resolveInsideExtensionDirectory(
  directory: string,
  relativePath: string
): string | null {
  const target = resolve(directory, relativePath.replace(/^\/+/, ''))
  const rel = relative(resolve(directory), target)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? target : null
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''))
}

/** Why: store manifests name themselves `__MSG_key__`; Settings must show the real name even when unloaded. */
export async function localizeManifestString(
  directory: string,
  manifest: Record<string, unknown>,
  value: string
): Promise<string> {
  const match = /^__MSG_(\w+)__$/.exec(value)
  const locale = manifest.default_locale
  if (!match || typeof locale !== 'string') {
    return value
  }
  const messagesPath = resolveInsideExtensionDirectory(
    directory,
    join('_locales', locale, 'messages.json')
  )
  if (!messagesPath) {
    return value
  }
  try {
    const messages = asRecord(await readJson(messagesPath)) ?? {}
    const wanted = match[1].toLowerCase()
    for (const [key, entry] of Object.entries(messages)) {
      const message = asRecord(entry)?.message
      if (key.toLowerCase() === wanted && typeof message === 'string') {
        return message
      }
    }
  } catch {
    // Fall back to the raw key.
  }
  return value
}

function pickIconPath(manifest: Record<string, unknown>): string | null {
  const action = asRecord(manifest.action) ?? asRecord(manifest.browser_action)
  const candidates = asRecord(manifest.icons) ?? asRecord(action?.default_icon)
  if (!candidates) {
    return typeof action?.default_icon === 'string' ? action.default_icon : null
  }
  const sized = Object.entries(candidates)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([size, path]) => ({ size: Number.parseInt(size, 10) || 0, path }))
    .sort((a, b) => a.size - b.size)
  const fitting = sized.filter((icon) => icon.size <= PREFERRED_ICON_SIZE)
  return (fitting.at(-1) ?? sized.at(-1))?.path ?? null
}

export async function readBrowserExtensionManifest(
  directory: string
): Promise<BrowserExtensionManifestSummary> {
  const manifest = asRecord(await readJson(join(directory, 'manifest.json')))
  if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error('manifest.json needs a name and a version')
  }
  const permissions = stringList(manifest.permissions)
  const optionsUi = asRecord(manifest.options_ui)
  const optionsPage =
    typeof optionsUi?.page === 'string'
      ? optionsUi.page
      : typeof manifest.options_page === 'string'
        ? manifest.options_page
        : null
  return {
    name: await localizeManifestString(directory, manifest, manifest.name),
    version: manifest.version,
    iconPath: pickIconPath(manifest),
    // MV2 lists hosts among permissions; MV3 moved them to host_permissions.
    permissions: permissions.filter((permission) => !isHostPermission(permission)),
    hostPermissions: [
      ...permissions.filter(isHostPermission),
      ...stringList(manifest.host_permissions)
    ],
    optionsPage
  }
}

export async function readBrowserExtensionIconDataUrl(
  directory: string,
  iconPath: string | null
): Promise<string | null> {
  if (!iconPath) {
    return null
  }
  const absolute = resolveInsideExtensionDirectory(directory, iconPath)
  const mime = absolute ? ICON_MIME_BY_EXTENSION[extname(absolute).toLowerCase()] : undefined
  if (!absolute || !mime) {
    return null
  }
  try {
    if ((await stat(absolute)).size > MAX_ICON_BYTES) {
      return null
    }
    return `data:${mime};base64,${(await readFile(absolute)).toString('base64')}`
  } catch {
    return null
  }
}
