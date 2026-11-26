import { TAG as htmlTag } from './mobile-markdown-html-images'
import { attrValue } from './mobile-markdown-preview-html'

export function isCenteredImageRow(html: string): boolean {
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
