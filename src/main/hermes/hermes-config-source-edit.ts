import { CST, isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit } from 'yaml'
import type { Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml'

import type { HermesConfig } from './hermes-config-yaml'
import { HERMES_PLUGIN_NAME } from './hermes-managed-plugin-source'

type Edit = { start: number; end: number; text: string }
type PluginField = 'enabled' | 'disabled'

function pluginsOf(config: HermesConfig): Record<string, unknown> {
  const plugins = config.plugins
  return typeof plugins === 'object' && plugins !== null && !Array.isArray(plugins)
    ? Object.fromEntries(Object.entries(plugins))
    : {}
}

function token(type: CST.SourceToken['type'], source: string): CST.SourceToken {
  return { type, source, offset: 0, indent: 0 }
}

function assertEditable(
  node: unknown,
  aliasedNodes: Set<Scalar | YAMLMap | YAMLSeq>,
  recursive = false
): void {
  if (!isNode(node)) {
    return
  }
  if (isAlias(node) || aliasedNodes.has(node)) {
    throw new Error('Cannot safely edit aliased Hermes plugin settings')
  }
  if (recursive && isSeq(node)) {
    for (const item of node.items) {
      assertEditable(item, aliasedNodes, true)
    }
  } else if (recursive && isMap(node)) {
    for (const pair of node.items) {
      assertEditable(pair.key, aliasedNodes, true)
      assertEditable(pair.value, aliasedNodes, true)
    }
  }
}

function insertFields(map: YAMLMap, fields: [string, unknown][], newline: string): Edit {
  const source = map.srcToken
  if (!source || (source.type !== 'block-map' && source.type !== 'flow-collection')) {
    throw new Error('Cannot locate Hermes plugin settings in YAML source')
  }
  const entries = fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  if (source.type === 'flow-collection') {
    const start = source.start.offset + source.start.source.length
    return { start, end: start, text: entries.join(', ') + (map.items.length ? ', ' : '') }
  }
  const separator = newline + ' '.repeat(source.indent)
  return { start: source.offset, end: source.offset, text: entries.join(separator) + separator }
}

function replaceValue(pair: Pair, value: unknown, content: string): Edit {
  const node = pair.value
  if (isNode(node) && node.range && node.range[1] > node.range[0]) {
    const [start, end] = node.range
    const trailingNewline = content.slice(start, end).match(/\r?\n$/)?.[0] ?? ''
    return { start, end, text: JSON.stringify(value) + trailingNewline }
  }
  const colon = pair.srcToken?.sep?.find((item) => item.type === 'map-value-ind')
  if (!colon) {
    throw new Error('Cannot locate empty Hermes plugin setting in YAML source')
  }
  const start = colon.offset + colon.source.length
  return { start, end: start, text: ` ${JSON.stringify(value)}` }
}

function editSequence(sequence: YAMLSeq, next: string[], newline: string): Edit {
  const source = sequence.srcToken
  if (!source || (source.type !== 'block-seq' && source.type !== 'flow-collection')) {
    throw new Error('Cannot locate Hermes plugin list in YAML source')
  }
  // A block-list footer may also own the next key's indentation; leave it outside the edit.
  const sourceItems =
    source.type === 'block-seq' ? source.items.filter((item) => item.value) : source.items
  const original =
    source.type === 'block-seq'
      ? sourceItems.map((item) => CST.stringify(item)).join('')
      : CST.stringify(source)
  const removeOrca = !next.includes(HERMES_PLUGIN_NAME)
  const appendOrca =
    next.includes(HERMES_PLUGIN_NAME) &&
    !sequence.items.some((item) => isScalar(item) && item.value === HERMES_PLUGIN_NAME)
  const items = sourceItems.flatMap<CST.CollectionItem>((item, index) => {
    const node = sequence.items[index]
    if (removeOrca && isScalar(node) && node.value === HERMES_PLUGIN_NAME) {
      // A flow item's leading comment can describe the preceding, retained plugin.
      return source.type === 'flow-collection' && item.start.some((part) => part.type === 'comment')
        ? [{ start: item.start.filter((part) => part.type !== 'comma') }]
        : []
    }
    return [{ ...item, start: [...item.start] }]
  })

  if (source.type === 'flow-collection') {
    const first = items.find((item) => item.value)
    if (first) {
      first.start = first.start.filter((item) => item.type !== 'comma')
    } else {
      for (const item of items) {
        item.start = item.start.filter((part) => part.type !== 'comma')
      }
    }
    if (appendOrca) {
      const lastValue = items.findLastIndex((item) => item.value)
      items.splice(lastValue + 1, 0, {
        start: lastValue !== -1 ? [token('comma', ','), token('space', ' ')] : [],
        value: { type: 'scalar', offset: 0, indent: 0, source: HERMES_PLUGIN_NAME }
      })
    }
    const text = CST.stringify({ ...source, items })
    return { start: source.offset, end: source.offset + original.length, text }
  }

  // The parent mapping owns the first item's indentation; later items own theirs.
  if (items[0]?.start[0]?.type === 'space') {
    items[0].start.shift()
  }
  let text = items.map((item) => CST.stringify(item)).join('')
  if (appendOrca) {
    if (text && !text.endsWith('\n')) {
      text += newline
    }
    text += `${text ? ' '.repeat(source.indent) : ''}- ${HERMES_PLUGIN_NAME}`
  }
  if (!text) {
    text = '[]'
  }
  if (original.endsWith('\n') && !text.endsWith('\n')) {
    text += newline
  }
  if (!original.endsWith('\n') && text.endsWith('\n')) {
    text = text.slice(0, -newline.length)
  }
  return { start: source.offset, end: source.offset + original.length, text }
}

function editField(
  pair: Pair,
  value: unknown,
  content: string,
  newline: string,
  aliasedNodes: Set<Scalar | YAMLMap | YAMLSeq>
): Edit {
  assertEditable(pair.value, aliasedNodes, true)
  if (
    isSeq(pair.value) &&
    pair.value.items.every((item) => isScalar(item) && typeof item.value === 'string') &&
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string')
  ) {
    return editSequence(pair.value, value, newline)
  }
  return replaceValue(pair, value, content)
}

export function editHermesPluginLists(
  content: string,
  config: HermesConfig,
  next: HermesConfig
): string {
  const previousPlugins = pluginsOf(config)
  const nextPlugins = pluginsOf(next)
  const fields = (['enabled', 'disabled'] as const).filter(
    (field) => JSON.stringify(previousPlugins[field]) !== JSON.stringify(nextPlugins[field])
  )
  if (!fields.length) {
    return content
  }

  const document = parseDocument(content, { keepSourceTokens: true })
  if (document.errors.length) {
    throw document.errors[0]
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const aliasedNodes = new Set<Scalar | YAMLMap | YAMLSeq>()
  visit(document, {
    Alias: (_, node) => {
      const target = node.resolve(document)
      if (target) {
        aliasedNodes.add(target)
      }
    }
  })
  const root = document.contents
  assertEditable(root, aliasedNodes)
  const edits: Edit[] = []
  if (!isMap(root)) {
    const start = root?.range?.[0] ?? document.range?.[1] ?? content.length
    const end = root?.range?.[1] ?? start
    const before = start > 0 && content[start - 1] !== '\n' && start === end ? newline : ''
    const after = start === end && (end < content.length || content.endsWith('\n')) ? newline : ''
    edits.push({ start, end, text: before + JSON.stringify({ plugins: nextPlugins }) + after })
  } else {
    const pluginsPair = root.items.find(
      (pair) => isScalar(pair.key) && pair.key.value === 'plugins'
    )
    if (!pluginsPair) {
      edits.push(insertFields(root, [['plugins', nextPlugins]], newline))
    } else {
      assertEditable(pluginsPair.value, aliasedNodes)
      if (!isMap(pluginsPair.value)) {
        assertEditable(pluginsPair.value, aliasedNodes, true)
        edits.push(replaceValue(pluginsPair, nextPlugins, content))
      } else {
        const missing: [PluginField, unknown][] = []
        for (const field of fields) {
          const pair = pluginsPair.value.items.find(
            (item) => isScalar(item.key) && item.key.value === field
          )
          if (pair) {
            edits.push(editField(pair, nextPlugins[field], content, newline, aliasedNodes))
          } else {
            missing.push([field, nextPlugins[field]])
          }
        }
        if (missing.length) {
          edits.push(insertFields(pluginsPair.value, missing, newline))
        }
      }
    }
  }
  let result = content
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  }
  // Validate the splice before either local or remote callers can write it.
  const checked = parseDocument(result)
  if (checked.errors.length) {
    throw checked.errors[0]
  }
  const updated: unknown = checked.toJS()
  if (typeof updated !== 'object' || updated === null || !('plugins' in updated)) {
    throw new Error('Could not safely update Hermes plugin settings')
  }
  const checkedPlugins = pluginsOf(updated)
  if (
    fields.some(
      (field) => JSON.stringify(checkedPlugins[field]) !== JSON.stringify(nextPlugins[field])
    )
  ) {
    throw new Error('Could not safely update Hermes plugin lists')
  }
  return result
}
