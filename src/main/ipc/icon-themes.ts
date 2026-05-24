/* eslint-disable max-lines -- Why: this module is the single owner of the icon-theme import pipeline (folder/marketplace/zip/inline/persist) and splitting the closely coupled steps across files would scatter the security-critical path-containment invariants. */
/**
 * IPC for user-imported VS Code icon themes + the Open VSX marketplace browser.
 *
 * Import sources:
 *   1. Folder picker — user points at a folder containing either:
 *        a) a `*-icon-theme.json` (or any .json with `iconDefinitions`) at root, or
 *        b) an `extension/package.json` whose `contributes.iconThemes[0].path`
 *           points at the real JSON anywhere inside (the layout produced by
 *           unpacking a .vsix).
 *   2. Marketplace — user picks an entry from Open VSX search; the main process
 *      downloads the .vsix (zip), extracts it in-memory with adm-zip, and runs
 *      the same import pipeline as a folder pick.
 *
 * Whichever source produced the theme, every `iconPath` is inlined as a `data:`
 * URI on the persisted JSON. The renderer never touches the disk.
 */
import { dialog, ipcMain, net, type BrowserWindow, app } from 'electron'
import AdmZip from 'adm-zip'
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { dirname, join, relative, resolve } from 'path'

type IconDefinition = {
  iconPath?: string
  fontCharacter?: string
  fontColor?: string
  fontId?: string
  fontSize?: string
}

type VscodeFontSrc = { path: string; format: string }
type VscodeFont = {
  id: string
  src: VscodeFontSrc[]
  weight?: string
  style?: string
  size?: string
}

type VscodeIconThemeJson = {
  iconDefinitions?: Record<string, IconDefinition>
  fonts?: VscodeFont[]
  [key: string]: unknown
}

type VscodePackageJson = {
  name?: string
  displayName?: string
  contributes?: {
    iconThemes?: { id?: string; label?: string; path?: string }[]
    productIconThemes?: { id?: string; label?: string; path?: string }[]
  }
}

export type StoredUserIconTheme = {
  id: string
  /** Original folder/extension basename, surfaced in the dropdown when no `name` in JSON. */
  sourceFolderName: string
  /** Resolved JSON with all `iconPath` values rewritten to inline data URIs. */
  json: VscodeIconThemeJson
}

export type MarketplaceExtension = {
  publisher: string
  name: string
  displayName: string
  description: string
  version: string
  downloadUrl: string
  iconUrl: string | null
  downloadCount: number
}

const USER_THEMES_DIRNAME = 'icon-themes'
const OPEN_VSX_BASE = 'https://open-vsx.org/api'

function userThemesDir(): string {
  return join(app.getPath('userData'), USER_THEMES_DIRNAME)
}

function sanitizeId(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'user-theme'
  )
}

class NotAFileIconThemeError extends Error {
  constructor(kind: string) {
    super(
      `This extension is a ${kind} theme, not a file icon theme. ` +
        'Only VS Code file icon themes (with iconDefinitions) are supported.'
    )
    this.name = 'NotAFileIconThemeError'
  }
}

async function findThemeJson(folder: string): Promise<string | null> {
  for (const pkgCandidate of [
    join(folder, 'package.json'),
    join(folder, 'extension', 'package.json')
  ]) {
    try {
      const raw = await readFile(pkgCandidate, 'utf8')
      const parsed = JSON.parse(raw) as VscodePackageJson
      const themes = parsed.contributes?.iconThemes
      if (themes && themes.length > 0 && themes[0].path) {
        return resolve(dirname(pkgCandidate), themes[0].path)
      }
      // Why: product icon themes (UI icons, not file icons) have a different
      // contributes key. Detect early so the user gets a clear error instead
      // of "no icon-theme JSON found".
      if (parsed.contributes?.productIconThemes?.length) {
        throw new NotAFileIconThemeError('product icon')
      }
    } catch (err) {
      if (err instanceof NotAFileIconThemeError) {
        throw err
      }
      /* fallthrough */
    }
  }

  // Scan the folder (and extension/ subfolder) for any .json with iconDefinitions.
  const dirsToScan = [folder, join(folder, 'extension')]
  for (const dir of dirsToScan) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry === 'package.json') {
        continue
      }
      const path = join(dir, entry)
      try {
        const raw = await readFile(path, 'utf8')
        const parsed = JSON.parse(raw) as VscodeIconThemeJson
        if (parsed && typeof parsed === 'object' && parsed.iconDefinitions) {
          return path
        }
      } catch {
        /* skip malformed */
      }
    }
  }
  return null
}

function isContainedIn(child: string, parent: string): boolean {
  const resolved = resolve(child)
  const base = resolve(parent)
  const sep = base.includes('\\') ? '\\' : '/'
  return resolved.startsWith(base + sep) || resolved === base
}

const FONT_MIME: Record<string, string> = {
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf'
}

async function inlineFonts(
  jsonPath: string,
  json: VscodeIconThemeJson
): Promise<VscodeFont[] | undefined> {
  if (!json.fonts?.length) {
    return undefined
  }
  const baseDir = dirname(jsonPath)
  const result: VscodeFont[] = []
  for (const font of json.fonts) {
    const inlinedSrc: VscodeFontSrc[] = []
    for (const src of font.src) {
      if (typeof src.path !== 'string') {
        continue
      }
      const absolute = resolve(baseDir, src.path)
      if (!isContainedIn(absolute, baseDir)) {
        continue
      }
      try {
        const buf = await readFile(absolute)
        const mime = FONT_MIME[src.format] ?? `font/${src.format}`
        inlinedSrc.push({
          path: `data:${mime};base64,${buf.toString('base64')}`,
          format: src.format
        })
      } catch {
        // Skip missing font files
      }
    }
    if (inlinedSrc.length > 0) {
      result.push({ ...font, src: inlinedSrc })
    }
  }
  return result.length > 0 ? result : undefined
}

async function inlineSvgs(
  jsonPath: string,
  json: VscodeIconThemeJson
): Promise<VscodeIconThemeJson> {
  const baseDir = dirname(jsonPath)
  const definitions = json.iconDefinitions ?? {}
  const next: Record<string, IconDefinition> = {}
  // Why: VS Code icon themes commonly reuse the same SVG across many keys
  // (a single `_file_default` mapped from dozens of extensions). Caching the
  // data URI per resolved path keeps the resolved JSON small and avoids
  // re-reading the same file off disk.
  const dataUriByAbsPath = new Map<string, string>()
  for (const [key, def] of Object.entries(definitions)) {
    if (!def || typeof def !== 'object') {
      next[key] = def
      continue
    }
    if (!def.iconPath) {
      next[key] = def
      continue
    }
    const absolute = resolve(baseDir, def.iconPath)
    if (!isContainedIn(absolute, baseDir)) {
      next[key] = { ...def, iconPath: undefined }
      continue
    }
    let dataUri = dataUriByAbsPath.get(absolute)
    if (!dataUri) {
      try {
        const buf = await readFile(absolute)
        dataUri = `data:image/svg+xml;base64,${buf.toString('base64')}`
        dataUriByAbsPath.set(absolute, dataUri)
      } catch {
        next[key] = { ...def, iconPath: undefined }
        continue
      }
    }
    next[key] = { ...def, iconPath: dataUri }
  }
  const fonts = await inlineFonts(jsonPath, json)
  return { ...json, iconDefinitions: next, ...(fonts ? { fonts } : {}) }
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

async function listUserThemes(): Promise<StoredUserIconTheme[]> {
  const dir = userThemesDir()
  await ensureDir(dir)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const out: StoredUserIconTheme[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue
    }
    try {
      const raw = await readFile(join(dir, entry), 'utf8')
      const parsed = JSON.parse(raw) as StoredUserIconTheme
      if (parsed && parsed.id && parsed.json) {
        out.push(parsed)
      }
    } catch {
      /* skip corrupt */
    }
  }
  return out
}

async function persistTheme(stored: StoredUserIconTheme): Promise<void> {
  await ensureDir(userThemesDir())
  await writeFile(join(userThemesDir(), `${stored.id}.json`), JSON.stringify(stored), 'utf8')
}

async function importFromFolder(
  folderPath: string,
  options: { id?: string; sourceFolderName?: string } = {}
): Promise<StoredUserIconTheme> {
  const jsonPath = await findThemeJson(folderPath)
  if (!jsonPath) {
    throw new Error('No icon-theme JSON found in folder (expected a .json with `iconDefinitions`).')
  }
  const raw = await readFile(jsonPath, 'utf8')
  const parsed = JSON.parse(raw) as VscodeIconThemeJson
  if (!parsed.iconDefinitions || typeof parsed.iconDefinitions !== 'object') {
    throw new Error('JSON is not a valid VS Code icon theme (missing `iconDefinitions`).')
  }
  const resolvedJson = await inlineSvgs(jsonPath, parsed)
  const folderBase =
    options.sourceFolderName ?? (relative(dirname(folderPath), folderPath) || folderPath)
  const id = sanitizeId(options.id ?? folderBase)
  const stored: StoredUserIconTheme = { id, sourceFolderName: folderBase, json: resolvedJson }
  await persistTheme(stored)
  return stored
}

// ── Open VSX marketplace ────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 30_000
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

function fetchBuffer(url: string): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const request = net.request({ url, method: 'GET', redirect: 'follow' })
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        request.abort()
        reject(new Error(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`))
      }
    }, FETCH_TIMEOUT_MS)
    const settle = (fn: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      fn()
    }
    request.on('response', (response) => {
      if ((response.statusCode ?? 0) >= 400) {
        settle(() => reject(new Error(`HTTP ${response.statusCode} for ${url}`)))
        return
      }
      response.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length
        if (totalBytes > MAX_DOWNLOAD_BYTES) {
          request.abort()
          settle(() =>
            reject(new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB limit.`))
          )
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => settle(() => resolvePromise(Buffer.concat(chunks))))
      response.on('error', (err) => settle(() => reject(err)))
    })
    request.on('error', (err) => settle(() => reject(err)))
    request.end()
  })
}

async function fetchJson<T>(url: string): Promise<T> {
  const buf = await fetchBuffer(url)
  return JSON.parse(buf.toString('utf8')) as T
}

type OpenVsxSearchResponse = {
  offset: number
  totalSize: number
  extensions: {
    name: string
    namespace: string
    displayName?: string
    description?: string
    version: string
    downloadCount?: number
    files?: { download?: string; icon?: string }
  }[]
}

type OpenVsxExtensionDetail = {
  tags?: string[]
  categories?: string[]
}

// Why: the search endpoint returns a mix of file icon themes, product icon
// themes, and color themes. We verify each result against its individual
// metadata to confirm it is a *file* icon theme (has `icon-theme` tag but
// NOT `product-icon-theme`). This adds a small latency per-result but
// avoids showing themes that will fail on install.
async function isFileIconTheme(publisher: string, name: string): Promise<boolean> {
  // Why: some product icon themes are mis-tagged with `icon-theme` on Open VSX.
  // The name "product-icons" is a reliable signal to reject them early.
  if (name.toLowerCase().includes('product-icon')) {
    return false
  }
  try {
    const detail = await fetchJson<OpenVsxExtensionDetail>(
      `${OPEN_VSX_BASE}/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}`
    )
    const tags = detail.tags ?? []
    if (tags.includes('icon-theme')) {
      return true
    }
    if (tags.includes('product-icon-theme')) {
      return false
    }
    const combined = `${publisher} ${name}`.toLowerCase()
    return combined.includes('icon')
  } catch {
    return true
  }
}

async function searchMarketplace(query: string): Promise<MarketplaceExtension[]> {
  const safeQuery = query.trim().slice(0, 80)
  const params = new URLSearchParams({
    category: 'Themes',
    size: '50',
    sortBy: 'downloadCount',
    sortOrder: 'desc',
    query: safeQuery ? `${safeQuery} icon` : 'file icon theme'
  })
  const url = `${OPEN_VSX_BASE}/-/search?${params.toString()}`
  const data = await fetchJson<OpenVsxSearchResponse>(url)

  const candidates = data.extensions
    .filter((ext) => ext.files?.download)
    .map((ext) => ({
      publisher: ext.namespace,
      name: ext.name,
      displayName: ext.displayName ?? ext.name,
      description: ext.description ?? '',
      version: ext.version,
      downloadUrl: ext.files!.download!,
      iconUrl: ext.files?.icon ?? null,
      downloadCount: ext.downloadCount ?? 0
    }))

  const results: MarketplaceExtension[] = []
  const CONCURRENCY = 5
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY)
    const checks = await Promise.all(
      batch.map(async (c) => ({
        ext: c,
        ok: await isFileIconTheme(c.publisher, c.name)
      }))
    )
    for (const c of checks) {
      if (c.ok) {
        results.push(c.ext)
      }
    }
  }
  return results
}

const ALLOWED_DOWNLOAD_HOSTS = new Set(['open-vsx.org', 'www.open-vsx.org'])

async function installFromMarketplace(args: {
  publisher: string
  name: string
  downloadUrl: string
  displayName?: string
}): Promise<StoredUserIconTheme> {
  const parsed = new URL(args.downloadUrl)
  if (parsed.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)) {
    throw new Error(`Download blocked: only HTTPS from open-vsx.org is allowed.`)
  }
  const vsixBuffer = await fetchBuffer(args.downloadUrl)
  // Extract the vsix (a ZIP) into a per-extension folder inside userData so we
  // can resolve `iconPath` references against real on-disk SVGs. We keep the
  // extraction around — `inlineSvgs` reads each SVG by path, then we delete.
  const extractRoot = join(userThemesDir(), '.tmp', `${args.publisher}.${args.name}`)
  await ensureDir(extractRoot)
  try {
    await rm(extractRoot, { recursive: true, force: true })
    await ensureDir(extractRoot)
    const zip = new AdmZip(vsixBuffer)
    for (const entry of zip.getEntries()) {
      const target = resolve(extractRoot, entry.entryName)
      if (!isContainedIn(target, extractRoot)) {
        continue
      }
      if (entry.isDirectory) {
        await mkdir(target, { recursive: true })
      } else {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, entry.getData())
      }
    }
    const id = sanitizeId(`${args.publisher}-${args.name}`)
    const sourceFolderName = args.displayName ?? `${args.publisher}.${args.name}`
    return await importFromFolder(extractRoot, { id, sourceFolderName })
  } finally {
    await rm(extractRoot, { recursive: true, force: true }).catch(() => {})
  }
}

// ── handlers ───────────────────────────────────────────────────────────────

export function registerIconThemeHandlers(mainWindow: BrowserWindow): void {
  ipcMain.removeHandler('icon-themes:list')
  ipcMain.removeHandler('icon-themes:pickAndImport')
  ipcMain.removeHandler('icon-themes:remove')
  ipcMain.removeHandler('icon-themes:searchMarketplace')
  ipcMain.removeHandler('icon-themes:installFromMarketplace')

  ipcMain.handle('icon-themes:list', async () => listUserThemes())

  ipcMain.handle('icon-themes:pickAndImport', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Import VS Code icon theme',
      message: 'Pick the folder containing the icon-theme JSON and its /icons.',
      properties: ['openDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return null
    }
    return importFromFolder(picked.filePaths[0])
  })

  ipcMain.handle('icon-themes:remove', async (_event, id: string) => {
    const safe = sanitizeId(id)
    await rm(join(userThemesDir(), `${safe}.json`), { force: true })
  })

  ipcMain.handle('icon-themes:searchMarketplace', async (_event, query: string) =>
    searchMarketplace(query ?? '')
  )

  ipcMain.handle(
    'icon-themes:installFromMarketplace',
    async (
      _event,
      args: { publisher: string; name: string; downloadUrl: string; displayName?: string }
    ) => installFromMarketplace(args)
  )
}
