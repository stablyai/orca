import type { PhrasingContent } from 'mdast'
import { escapeMarkdownTextLinkDestination } from './adf-media-destination'

function escapeLiteral(value: string, inLink: boolean): string {
  return value
    .replace(/[\\`*_~[<>]/g, (char, index: number) =>
      char === '_' &&
      /[\p{L}\p{N}]/u.test(value[index - 1] ?? '') &&
      /[\p{L}\p{N}]/u.test(value[index + 1] ?? '')
        ? char
        : `\\${char}`
    )
    .replace(/]/g, inLink ? '\\]' : ']')
    .replace(/&(?=(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[\da-fA-F]+);)/g, '\\&')
}

function escapeBlockMarkers(value: string, lineStart: boolean): string {
  return value
    .replace(
      /^([ \t]*)([#>+=-]|\d+[.)])/gm,
      (_match, indent: string, marker: string, offset: number) =>
        offset === 0 && !lineStart ? _match : `${indent}${marker.slice(0, -1)}\\${marker.at(-1)}`
    )
    .replace(/^( {4}|\t)/gm, (indent, _capture, offset: number) =>
      offset === 0 && !lineStart ? indent : indent === '\t' ? '&#9;' : '&#32;   '
    )
}

function escapeDestinationEntities(value: string): string {
  return value.replace(/&(?=(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[\da-fA-F]+);)/g, '&amp;')
}

function inlineCode(value: string): string {
  let longest = 0
  for (const match of value.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length)
  }
  const fence = '`'.repeat(longest + 1)
  const padding = /^`|`$|^ .* $/s.test(value) && /[^ ]/.test(value) ? ' ' : ''
  return `${fence}${padding}${value}${padding}${fence}`
}

type InlineToken = {
  value: string
  url?: string
  explicitLink?: boolean
  literal?: boolean
  style?: 'open' | 'close'
}

function inlineTokens(
  nodes: PhrasingContent[],
  inLink: boolean,
  inTable: boolean,
  tokens: InlineToken[]
): void {
  for (const [index, node] of nodes.entries()) {
    switch (node.type) {
      case 'text':
        tokens.push({ value: escapeLiteral(node.value, inLink), literal: true })
        break
      case 'jiraAutolink':
        tokens.push({ value: node.value, url: node.url })
        break
      case 'jiraMedia':
      case 'html':
        tokens.push({ value: node.value })
        break
      case 'inlineCode':
        tokens.push({ value: inlineCode(inTable ? node.value.replace(/\|/g, '\\|') : node.value) })
        break
      case 'break':
        tokens.push({ value: inTable ? '<br>' : '\n' })
        break
      case 'link': {
        const url = escapeMarkdownTextLinkDestination(node.url)
        if (url) {
          tokens.push({ value: '[', explicitLink: true })
        }
        inlineTokens(node.children, true, inTable, tokens)
        if (url) {
          tokens.push({ value: `](${escapeDestinationEntities(url)})` })
        }
        break
      }
      case 'strong':
      case 'emphasis':
      case 'delete': {
        // Different markers keep adjacent strong/emphasis runs separate without reparsing.
        const before = nodes[index - 1]
        const after = nodes[index + 1]
        const intraword =
          node.type === 'emphasis' &&
          ((before?.type === 'text' && /[\p{L}\p{N}]$/u.test(before.value)) ||
            (after?.type === 'text' && /^[\p{L}\p{N}]/u.test(after.value)))
        const marker =
          node.type === 'strong' ? '**' : node.type === 'delete' ? '~~' : intraword ? '*' : '_'
        tokens.push({ value: marker, style: 'open' })
        inlineTokens(node.children, inLink, inTable, tokens)
        tokens.push({ value: marker, style: 'close' })
        break
      }
      case 'linkReference':
        inlineTokens(node.children, inLink, inTable, tokens)
        break
      case 'footnoteReference':
      case 'image':
      case 'imageReference':
        break
    }
  }
}

function supportsUriAutolink(value: string): boolean {
  for (const char of value) {
    if (char.charCodeAt(0) <= 0x20 || char === '<' || char === '>') {
      return false
    }
  }
  return true
}

export function renderInlineMarkdown(
  nodes: PhrasingContent[],
  inTable: boolean,
  heading: boolean
): string {
  const tokens: InlineToken[] = []
  inlineTokens(nodes, false, inTable, tokens)
  const rightBoundary: boolean[] = []
  let boundary = true
  for (let index = tokens.length - 1; index >= 0; index--) {
    rightBoundary[index] = boundary
    if (tokens[index].value) {
      boundary = /^\s/u.test(tokens[index].value)
    }
  }
  const rendered: InlineToken[] = []
  boundary = true
  let lineStart = true
  for (const [index, token] of tokens.entries()) {
    if (!token.value) {
      continue
    }
    let value = token.value
    if (token.literal) {
      value = heading ? value.replace(/#/g, '\\#') : escapeBlockMarkers(value, lineStart)
    }
    let explicit = token.explicitLink
    if (token.url && !(boundary && rightBoundary[index])) {
      if (/^https?:\/\//i.test(value) && supportsUriAutolink(value)) {
        value = `<${value}>`
      } else {
        const url = escapeMarkdownTextLinkDestination(token.url)
        if (url) {
          value = `[${escapeLiteral(value, true)}](${escapeDestinationEntities(url)})`
          explicit = true
        }
      }
    }
    const previous = rendered.at(-1)
    if (explicit && previous?.value.endsWith('!')) {
      previous.value = `${previous.value.slice(0, -1)}\\!`
    }
    rendered.push({ ...token, value })
    boundary = /\s$/u.test(value)
    lineStart = value.endsWith('\n')
  }
  const nextCharacters: string[] = []
  let next = ''
  for (let index = rendered.length - 1; index >= 0; index--) {
    nextCharacters[index] = next
    next = firstCharacter(rendered[index].value)
  }
  const output: string[] = []
  let encodeNext = false
  for (const [index, token] of rendered.entries()) {
    let value = token.value
    if (encodeNext) {
      const first = firstCharacter(value)
      value = `${characterEntity(first)}${value.slice(first.length)}`
    }
    encodeNext = false
    const previous = output.at(-1) ?? ''
    const before = lastCharacter(previous)
    const after = nextCharacters[index]
    if (
      token.style === 'open' &&
      needsFlankingBoundary(before, token.value !== '~~') &&
      /[\p{P}\p{S}]/u.test(after)
    ) {
      output[output.length - 1] = `${previous.slice(0, -before.length)}${characterEntity(before)}`
    }
    if (
      token.style === 'close' &&
      /[\p{P}\p{S}]/u.test(before) &&
      needsFlankingBoundary(after, token.value !== '~~')
    ) {
      encodeNext = true
    }
    output.push(value)
  }
  return output.join('')
}

function firstCharacter(value: string): string {
  return /^./u.exec(value)?.[0] ?? ''
}

function lastCharacter(value: string): string {
  const last = value.charCodeAt(value.length - 1)
  return value.slice(last >= 0xdc00 && last <= 0xdfff ? -2 : -1)
}

function needsFlankingBoundary(char: string, cjkAttention: boolean): boolean {
  // Only attention delimiters get the shared CJK grammar's relaxed word boundary.
  return (
    !!char &&
    !/[\s\p{P}\p{S}]/u.test(char) &&
    !(
      cjkAttention &&
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)
    )
  )
}

function characterEntity(char: string): string {
  return `&#${char.codePointAt(0)};`
}
