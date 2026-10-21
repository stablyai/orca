import { isDeepStrictEqual } from 'node:util'
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit } from 'yaml'
import type { Document, YAMLMap, YAMLSeq } from 'yaml'
import type { HermesConfig } from './hermes-config-yaml'
import { applyHermesPluginSourceEdits } from './hermes-config-source-edits'

function preserveRemovedComments(sequence: YAMLSeq, removed: unknown[], first: unknown): void {
  const comments = removed.flatMap((node) =>
    isNode(node)
      ? [node === first && !sequence.flow ? null : node.commentBefore, node.comment].filter(
          (text) => text != null
        )
      : []
  )
  if (comments.length > 0) {
    sequence.comment = [sequence.comment, ...comments].filter((text) => text != null).join('\n')
  }
}

function updateStringSequence(plugins: YAMLMap, key: string, values: unknown): void {
  if (values === undefined) {
    return
  }
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new Error(`Hermes plugins.${key} must be a string list`)
  }
  const sequence = plugins.get(key, true)
  if (sequence === undefined) {
    plugins.set(key, values)
    return
  }
  if (!isSeq(sequence)) {
    throw new Error(`Hermes plugins.${key} must be a string list`)
  }
  const remaining = [...values]
  const removed: unknown[] = []
  const first = sequence.items[0]
  sequence.items = sequence.items.filter((item) => {
    if (!isScalar(item) || typeof item.value !== 'string') {
      throw new Error(`Hermes plugins.${key} must contain plain string entries`)
    }
    const index = remaining.indexOf(item.value)
    if (index === -1) {
      removed.push(item)
      return false
    }
    remaining.splice(index, 1)
    return true
  })
  preserveRemovedComments(sequence, removed, first)
  for (const value of remaining) {
    sequence.add(value)
  }
}

export function updateHermesPluginDocument(
  content: string,
  next: HermesConfig
): { content: string | null; detail?: string } {
  try {
    const document: Document = parseDocument(content)
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw new Error(
        [...document.errors, ...document.warnings].map((item) => item.message).join('; ')
      )
    }
    if (isScalar(document.contents) && document.contents.value === null) {
      const previous = document.contents
      document.contents = document.createNode({})
      document.contents.commentBefore = previous.commentBefore
      document.contents.comment = previous.comment
    }
    if (document.contents === null) {
      document.contents = document.createNode({})
    }
    if (!isMap(document.contents)) {
      throw new Error('Hermes config.yaml root must be a mapping')
    }
    if (document.contents.anchor) {
      throw new Error('Cannot safely edit an anchored Hermes root')
    }
    if (document.contents.has('<<')) {
      throw new Error('Cannot safely edit a merged Hermes root')
    }

    let plugins = document.get('plugins', true)
    if (plugins === undefined) {
      document.set('plugins', document.createNode({}))
      plugins = document.get('plugins', true)
    }
    if (!isMap(plugins)) {
      throw new Error('Hermes plugins must be a plain mapping')
    }
    // Aliases into a changed subtree could silently change unrelated settings.
    visit(plugins, {
      Node: (_key, node) => {
        if (isAlias(node) || node.anchor || node.tag) {
          throw new Error('Cannot safely edit Hermes plugins with anchors, aliases or tags')
        }
      },
      Pair: (_key, pair) => {
        if (isScalar(pair.key) && pair.key.value === '<<') {
          throw new Error('Cannot safely edit Hermes plugins with YAML merge keys')
        }
      }
    })
    for (const key of ['enabled', 'disabled']) {
      const existing = plugins.get(key, true)
      if (
        existing !== undefined &&
        (!isSeq(existing) ||
          existing.items.some((item) => !isScalar(item) || typeof item.value !== 'string'))
      ) {
        throw new Error(`Hermes plugins.${key} must be a string list`)
      }
    }
    const nextPlugins = next.plugins
    if (typeof nextPlugins !== 'object' || nextPlugins === null) {
      throw new Error('Hermes plugins must be a mapping')
    }
    if ('enabled' in nextPlugins) {
      updateStringSequence(plugins, 'enabled', nextPlugins.enabled)
    }
    if ('disabled' in nextPlugins) {
      updateStringSequence(plugins, 'disabled', nextPlugins.disabled)
    }
    const output = applyHermesPluginSourceEdits(content, document)
    // Re-parse to reject edits that would change any unrelated alias-resolved value.
    const verified = parseDocument(output)
    if (
      verified.errors.length > 0 ||
      verified.warnings.length > 0 ||
      !isDeepStrictEqual(verified.toJS(), next)
    ) {
      throw new Error('Hermes plugin update would change unrelated configuration')
    }
    return { content: output }
  } catch (error) {
    return { content: null, detail: error instanceof Error ? error.message : String(error) }
  }
}
