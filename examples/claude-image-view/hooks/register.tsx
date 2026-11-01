// Adapted from Jarrod Watts’ claude-image-view (MIT); see ../LICENSE.
import type { EngineInterface, Register } from 'claude-code'
import type { PastedImage } from '../types'
import { fitRow, imageNumbers, pngSize } from './layout'

const POLL_MS = 200
const RETRY_MS = 1000
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
let images: PastedImage[] = []
let sessionId: string | undefined
let directory: string | undefined
let tmpRoot: string | null | undefined
let shownKey: string | undefined
let checking = false
const cache = new Map<number, { image: PastedImage; retryAt: number }>()

function join(root: string, ...parts: string[]): string {
  const separator = root.includes('\\') ? '\\' : '/'
  return [root.replace(/[\\/]+$/, ''), ...parts].join(separator)
}

async function imagesDir($: EngineInterface, id: string): Promise<string | undefined> {
  if (directory !== undefined) {
    return directory
  }
  if (tmpRoot === null) {
    return undefined
  }
  let root = tmpRoot ?? (await $.env.get('CLAUDE_CODE_TMPDIR'))
  if (!root) {
    if ((await $.env.get('OS')) === 'Windows_NT') {
      tmpRoot = null
      return undefined
    }
    const uid = (await $.process.run(['id', '-u'])).stdout.trim()
    if (!/^\d+$/.test(uid)) {
      return undefined
    }
    root = `/tmp/claude-${uid}`
  }
  tmpRoot = root
  const entries = await $.fs.list(root).catch(() => [])
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.isLink) {
      continue
    }
    const candidate = join(root, entry.name, id, 'images')
    if (await $.fs.exists(candidate)) {
      directory = candidate
      return candidate
    }
  }
  return undefined
}

async function describe(
  $: EngineInterface,
  dir: string | undefined,
  n: number
): Promise<PastedImage> {
  const unavailable: PastedImage = { n, png: null, size: null }
  if (!dir) {
    return unavailable
  }
  const cached = cache.get(n)
  const now = await $.clock.now()
  if (cached && (cached.image.png !== null || now < cached.retryAt)) {
    return cached.image
  }
  // Failed reads expire so a partially written or temporarily inaccessible PNG can recover.
  cache.set(n, { image: unavailable, retryAt: now + RETRY_MS })
  try {
    const path = join(dir, `${n}.png`)
    const stat = await $.fs.stat(path)
    if (stat.kind !== 'file' || stat.isLink || stat.size > MAX_IMAGE_BYTES) {
      return unavailable
    }
    const { base64 } = await $.fs.read(path, { as: 'bytes' })
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    if ((base64.length / 4) * 3 - padding > MAX_IMAGE_BYTES) {
      return unavailable
    }
    const size = pngSize(base64)
    const image =
      size && size.width * size.height <= 8_000_000 ? { n, png: base64, size } : unavailable
    cache.set(n, { image, retryAt: now + RETRY_MS })
    return image
  } catch {
    return unavailable
  }
}

async function check($: EngineInterface) {
  if (checking) {
    return
  }
  checking = true
  try {
    const id = await $.session.id()
    if (sessionId !== id) {
      cache.clear()
      sessionId = id
      directory = undefined
      tmpRoot = undefined
      shownKey = undefined
      images = []
      $.ui.invalidate('ui.render')
    }
    const numbers = imageNumbers((await $.prompt.read()).text).slice(0, MAX_IMAGES)
    for (const n of cache.keys()) {
      if (!numbers.includes(n)) {
        cache.delete(n)
      }
    }
    const key = numbers.join(',')
    if (shownKey === key) {
      return
    }
    const dir = numbers.length ? await imagesDir($, id) : undefined
    const list: PastedImage[] = []
    for (const n of numbers) {
      list.push(await describe($, dir, n))
    }
    shownKey = list.every((image) => image.png !== null) ? key : undefined
    const changed =
      list.length !== images.length ||
      list.some((image, i) => image.n !== images[i]?.n || image.png !== images[i]?.png)
    images = list
    if (changed) {
      $.ui.invalidate('ui.render')
    }
  } catch {
    shownKey = undefined
  } finally {
    checking = false
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    if (e.surface === 'terminal') {
      $.clock.every(POLL_MS, () => check($))
    }
    return next(e)
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) {
      return next(e)
    }
    const list = images
    const visible = list.slice(0, Math.max(0, Math.floor((e.props.bodyColumns + 1) / 7)))
    if (!visible.length || e.props.maxRows < 4) {
      return next(e)
    }
    const { Box, Image, Text } = $.ui.resolve(e)
    const cells = fitRow(
      visible.map((image) => image.size),
      e.props.maxRows,
      e.props.bodyColumns
    )
    if (!cells.length) {
      return next(e)
    }
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {visible.slice(0, cells.length).map((image, i) => {
            const { columns, rows } = cells[i] ?? { columns: 4, rows: 1 }
            return (
              <Box
                key={`tile-${image.n}`}
                flexDirection="column"
                alignItems="center"
                borderStyle="round"
                borderDimColor
              >
                {image.png === null ? (
                  <Box width={columns} height={rows} alignItems="center" justifyContent="center">
                    <Text dimColor wrap="truncate">
                      no preview
                    </Text>
                  </Box>
                ) : (
                  <Image
                    key={`image-${image.n}`}
                    source={{ png: image.png }}
                    columns={columns}
                    rows={rows}
                    alt={`[Image #${image.n}]`}
                  />
                )}
                <Text dimColor>#{image.n}</Text>
              </Box>
            )
          })}
        </Box>
        {below}
      </Box>
    )
  })
}
