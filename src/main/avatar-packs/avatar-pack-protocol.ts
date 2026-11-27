import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { promises as fs } from 'node:fs'
import { protocol } from 'electron'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { AVATAR_PACK_SCHEME, avatarPackAssetRelativePath } from '../../shared/avatar-pack-scheme'
import { expandLeadingHomePath } from '../filesystem/home-path-expansion'

export const AVATAR_PACK_CUSTOM_SCHEME: Electron.CustomScheme = {
  scheme: AVATAR_PACK_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true
  }
}

const MIME_MAP: Record<string, string> = {
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
}

export type AvatarPacksResolveOptions = {
  getSettings?: () => Pick<GlobalSettings, 'avatarPacksDir'> | null | undefined
  env?: NodeJS.ProcessEnv
  homeDir?: string
  userDataDir?: string
  bypassCache?: boolean
}

let configuredGetSettings: AvatarPacksResolveOptions['getSettings']
let cachedPacksDir: { key: string; dir: string } | null = null

export function resetAvatarPacksDirCache(): void {
  cachedPacksDir = null
}

function isStrictlyInsideDir(parentDir: string, targetPath: string): boolean {
  const relPath = relative(parentDir, targetPath)
  if (!relPath || relPath.startsWith('..') || isAbsolute(relPath)) {
    return false
  }
  const prefix = parentDir.endsWith(sep) ? parentDir : `${parentDir}${sep}`
  return targetPath.startsWith(prefix)
}

export async function resolveAvatarPacksDir(
  options?: AvatarPacksResolveOptions
): Promise<string | null> {
  const home = options?.homeDir ?? homedir()
  const env = options?.env ?? process.env
  const userData = options?.userDataDir ?? getAppEnvironment().getPath('userData')
  const getSettings = options?.getSettings ?? configuredGetSettings
  const customDir = getSettings?.()?.avatarPacksDir?.trim() ?? ''
  const envAvatarPacksDir = env.ORCA_AVATAR_PACKS_DIR?.trim() ?? ''

  const cacheKey = [customDir, envAvatarPacksDir, home, userData].join('\0')
  if (!options?.bypassCache && cachedPacksDir && cachedPacksDir.key === cacheKey) {
    try {
      const stat = await fs.stat(join(cachedPacksDir.dir, 'catalog_index.json'))
      if (stat.isFile()) {
        return cachedPacksDir.dir
      }
    } catch {
      // Cached path is no longer valid; fall through to re-resolve.
    }
    cachedPacksDir = null
  }

  const candidates: string[] = []
  if (customDir) {
    candidates.push(expandLeadingHomePath(customDir, home))
  }
  if (envAvatarPacksDir) {
    candidates.push(expandLeadingHomePath(envAvatarPacksDir, home))
  }
  candidates.push(join(home, '.orca', 'avatar-packs'), join(userData, 'avatar-packs'))

  for (const dir of candidates) {
    try {
      const stat = await fs.stat(join(dir, 'catalog_index.json'))
      if (stat.isFile()) {
        cachedPacksDir = { key: cacheKey, dir }
        return dir
      }
    } catch {
      // Try next candidate.
    }
  }

  return null
}

export async function handleAvatarPackAssetRequest(
  request: Pick<Request, 'method' | 'url'>,
  options?: AvatarPacksResolveOptions
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405 })
  }

  const rawRel = avatarPackAssetRelativePath(request.url)
  if (!rawRel) {
    return new Response(null, { status: 400 })
  }

  let decodedRel: string
  try {
    decodedRel = decodeURIComponent(rawRel)
  } catch {
    return new Response(null, { status: 400 })
  }

  if (!decodedRel || decodedRel.includes('\0')) {
    return new Response(null, { status: 400 })
  }

  if (decodedRel.startsWith('/') || decodedRel.startsWith('\\') || isAbsolute(decodedRel)) {
    return new Response(null, { status: 403 })
  }

  const root = await resolveAvatarPacksDir({
    ...options,
    bypassCache: options?.bypassCache ?? decodedRel === 'catalog_index.json'
  })
  if (!root) {
    return new Response(JSON.stringify({ error: 'Avatar packs directory not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const resolvedRoot = resolve(root)
  const fullPath = resolve(resolvedRoot, decodedRel)
  if (!isStrictlyInsideDir(resolvedRoot, fullPath)) {
    return new Response(null, { status: 403 })
  }

  let realRoot: string
  let realPath: string
  try {
    realRoot = await fs.realpath(resolvedRoot)
    realPath = await fs.realpath(fullPath)
  } catch {
    return new Response(null, { status: 404 })
  }

  if (!isStrictlyInsideDir(realRoot, realPath)) {
    return new Response(null, { status: 403 })
  }

  try {
    const stat = await fs.stat(realPath)
    if (!stat.isFile()) {
      return new Response(null, { status: 404 })
    }
    const data = await fs.readFile(realPath)
    const ext = extname(realPath).toLowerCase()
    const mimeType = MIME_MAP[ext] ?? 'application/octet-stream'

    return new Response(request.method === 'HEAD' ? null : new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(data.byteLength),
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff'
      }
    })
  } catch {
    return new Response(null, { status: 404 })
  }
}

export function installAvatarPackProtocolHandler(
  options?: Pick<AvatarPacksResolveOptions, 'getSettings'>
): void {
  configuredGetSettings = options?.getSettings
  protocol.handle(AVATAR_PACK_SCHEME, (request) => handleAvatarPackAssetRequest(request, options))
}
