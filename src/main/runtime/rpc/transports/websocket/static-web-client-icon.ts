import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'

export const WEB_ICON_ROUTE = '/orca-web-icon'
export const WEB_ICON_CONTENT_TYPES = new Map([
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon']
])
const WEB_ICON_ENV_VAR = 'ORCA_WEB_ICON'
const WEB_ICON_EXTENSIONS = new Set(['.png', '.svg', '.ico', '.webp'])

type StaticWebIconEntry = {
  src: string
  // Declared slots the image can serve: its real dimensions plus the
  // installability sizes no larger than them (browsers scale down).
  sizes: string
  type: string
}

export type StaticWebIcon = {
  absolutePath: string
  contentType: string
  manifestIcons: StaticWebIconEntry[]
}

const INSTALLABILITY_ICON_EDGES = [192, 512]

/** ORCA_WEB_ICON wins for custom branding; otherwise the bundled assets/icon-*.png becomes the default. */
export async function resolveStaticWebIcon(
  staticRoot: string,
  files: ReadonlySet<string> | undefined,
  envPath: string | undefined
): Promise<StaticWebIcon | undefined> {
  const override = envPath?.trim()
  if (override) {
    const overrideExt = extname(override).toLowerCase()
    const contentType = WEB_ICON_CONTENT_TYPES.get(overrideExt)
    if (!isAbsolute(override) || !contentType || !WEB_ICON_EXTENSIONS.has(overrideExt)) {
      console.warn(
        `[ws-transport] ${WEB_ICON_ENV_VAR} ignored: ${override} is not an absolute path to ${[...WEB_ICON_EXTENSIONS].join('/')}`
      )
    } else {
      try {
        if ((await stat(override)).isFile()) {
          // Custom branding replaces the manifest icon list entirely.
          return {
            absolutePath: override,
            contentType,
            manifestIcons: [
              {
                src: WEB_ICON_ROUTE.slice(1),
                sizes: await manifestIconSizes(override),
                type: contentType
              }
            ]
          }
        }
      } catch {
        // fall through to the bundled icon
      }
      console.warn(`[ws-transport] ${WEB_ICON_ENV_VAR} ignored: cannot read ${override}`)
    }
  }
  const bundled = await findBundledWebIcons(staticRoot, files)
  if (bundled.length === 0) {
    return undefined
  }
  const primary = bundled.find((file) => /^assets\/icon-[^/]*\.png$/.test(file)) ?? bundled[0]
  return {
    absolutePath: join(staticRoot, primary),
    contentType: 'image/png',
    // Larger alternates ship beside the default icon; listing each at its own
    // path gives the manifest the 192/512 entries installability needs.
    manifestIcons: await Promise.all(
      bundled.map(async (file) => ({
        src: file,
        sizes: await manifestIconSizes(join(staticRoot, file)),
        type: 'image/png'
      }))
    )
  }
}

/** Every branded icon the web bundle emits: icon-*.png plus the alternate app icons. */
async function findBundledWebIcons(
  staticRoot: string,
  files: ReadonlySet<string> | undefined
): Promise<string[]> {
  const matches = (file: string) => /^assets\/(?:icon|orca)-[^/]*\.png$/.test(file)
  if (files) {
    return [...files].filter(matches).sort()
  }
  try {
    return (await readdir(join(staticRoot, 'assets')))
      .filter((entry) => matches(`assets/${entry}`))
      .sort()
      .map((entry) => `assets/${entry}`)
  } catch {
    return []
  }
}

async function manifestIconSizes(absolutePath: string): Promise<string> {
  const dimensions = await readPngDimensions(absolutePath)
  if (!dimensions) {
    return 'any'
  }
  const sizes = new Set([`${dimensions.width}x${dimensions.height}`])
  for (const edge of INSTALLABILITY_ICON_EDGES) {
    if (edge <= Math.min(dimensions.width, dimensions.height)) {
      sizes.add(`${edge}x${edge}`)
    }
  }
  return [...sizes].sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10)).join(' ')
}

async function readPngDimensions(
  absolutePath: string
): Promise<{ width: number; height: number } | undefined> {
  let fd: FileHandle | undefined
  try {
    const header = Buffer.alloc(24)
    fd = await open(absolutePath, 'r')
    await fd.read(header, 0, 24, 0)
    if (header.readUInt32BE(0) !== 0x89504e47) {
      return undefined
    }
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      await fd.close()
    }
  }
}
