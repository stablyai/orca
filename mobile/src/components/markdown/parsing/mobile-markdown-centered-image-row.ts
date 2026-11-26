import type { Html, ImageRow } from 'mdast'
import { TAG as htmlTag, VOID_TAGS } from './mobile-markdown-html-images'
import { attrValue } from './mobile-markdown-preview-html'

const markup = new RegExp(`<!--[\\s\\S]*?(?:-->|$)|${htmlTag.source}`, htmlTag.flags)

export function splitCenteredImageRows(html: string): (Html | ImageRow)[] {
  const blocks: (Html | ImageRow)[] = []
  const open: string[] = []
  let start = 0
  let from = 0
  for (const match of html.matchAll(markup)) {
    const name = match[2]?.toLowerCase()
    if (!name || VOID_TAGS.has(name) || match[0].endsWith('/>')) {
      continue
    }
    if (!match[1]) {
      if (open.length === 0) {
        start = match.index
      }
      open.push(name)
      continue
    }
    if (open.at(-1) !== name) {
      continue
    }
    open.pop()
    if (open.length > 0) {
      continue
    }
    const end = match.index + match[0].length
    const wrapper = html.slice(start, end)
    if (isCenteredImageRow(wrapper)) {
      const before = html.slice(from, start)
      if (before.trim()) {
        blocks.push({ type: 'html', value: before })
      }
      blocks.push({ type: 'imageRow', children: [{ type: 'html', value: wrapper }] })
      from = end
    }
  }
  const rest = html.slice(from)
  if (rest.trim()) {
    blocks.push({ type: 'html', value: rest })
  }
  return blocks
}

function isCenteredImageRow(html: string): boolean {
  const source = html.trim()
  const tags = source.matchAll(htmlTag)
  const first = tags.next().value
  if (
    !first ||
    first.index !== 0 ||
    first[1] ||
    attrValue(first[0], 'align').toLowerCase() !== 'center'
  ) {
    return false
  }
  const wrapper = first[2]!.toLowerCase()
  if (wrapper !== 'p' && !/^h[1-6]$/.test(wrapper)) {
    return false
  }
  let images = 0
  let hasText = false
  let end = first[0].length
  for (const tag of tags) {
    hasText ||= source.slice(end, tag.index).trim().length > 0
    end = tag.index + tag[0].length
    const name = tag[2]!.toLowerCase()
    if (name === wrapper && tag[1]) {
      return (
        end === source.length && (wrapper === 'p' ? images > 1 && !hasText : images > 0 && hasText)
      )
    }
    if (name === 'img' && !tag[1]) {
      images++
    } else if (name !== 'a') {
      return false
    }
  }
  return false
}
