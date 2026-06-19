import type { GlpiServer } from '../../shared/types'
import { glpiServerRequestBinary } from './session'

// GLPI rich-text stores inline images as Document references like
// `/front/document.send.php?docid=N&itemtype=Ticket&items_id=M`, which are
// relative to the GLPI server and require authentication. The renderer can't
// fetch those (they'd resolve against the app origin), so we download each one
// here and inline it as a data: URI that CommentMarkdown renders directly.

// CommentMarkdown only renders these mime types as inline images.
const COMPACT_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/
const MAX_INLINE_BYTES = 8 * 1024 * 1024
const MAX_IMAGES = 12
const DOC_URL_RE = /(src|href)="(\/front\/document\.send\.php\?docid=(\d+)[^"]*)"/g

function sniffImageMime(data: Buffer): string | null {
  if (data.length < 12) {
    return null
  }
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'image/png'
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return 'image/gif'
  }
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

async function fetchImageDataUri(server: GlpiServer, docId: number): Promise<string | null> {
  try {
    const res = await glpiServerRequestBinary(server, `/Document/${docId}`)
    if (!res || res.data.length === 0 || res.data.length > MAX_INLINE_BYTES) {
      return null
    }
    let mime = res.contentType.split(';')[0].trim().toLowerCase()
    if (!COMPACT_IMAGE_MIME.test(mime)) {
      const sniffed = sniffImageMime(res.data)
      if (!sniffed) {
        return null
      }
      mime = sniffed
    }
    if (mime === 'image/jpg') {
      mime = 'image/jpeg'
    }
    return `data:${mime};base64,${res.data.toString('base64')}`
  } catch {
    return null
  }
}

export async function inlineGlpiContentImages(server: GlpiServer, html: string): Promise<string> {
  if (!html || !html.includes('document.send.php')) {
    return html
  }
  const docIds = new Set<number>()
  for (const match of html.matchAll(DOC_URL_RE)) {
    docIds.add(Number(match[3]))
  }
  const dataUriById = new Map<number, string>()
  await Promise.all(
    [...docIds].slice(0, MAX_IMAGES).map(async (id) => {
      const uri = await fetchImageDataUri(server, id)
      if (uri) {
        dataUriById.set(id, uri)
      }
    })
  )
  return html.replace(DOC_URL_RE, (_whole, attr: string, relativeUrl: string, idText: string) => {
    const dataUri = dataUriById.get(Number(idText))
    if (attr === 'src' && dataUri) {
      return `src="${dataUri}"`
    }
    // Absolutize so the link/image targets the GLPI server, not the app origin.
    return `${attr}="${server.baseUrl}${relativeUrl}"`
  })
}
