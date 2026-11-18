import type { Nodes } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const markdown = unified().use(remarkParse).use(remarkGfm)

export function linearIssueDescriptionComparisonKey(description: string): string {
  const replacements = new Map<number, string>()
  const structure: string[] = []
  const pending: Nodes[] = [markdown.parse(description)]
  while (pending.length > 0) {
    const node = pending.pop()
    if (!node) {
      continue
    }
    structure.push(`${node.type}:${'children' in node ? node.children.length : 0}`)
    if (node.type === 'list' && !node.ordered) {
      for (const item of node.children) {
        const offset = item.position?.start.offset
        if (offset === undefined) {
          continue
        }
        const source = description.slice(offset, item.position?.end.offset)
        if (!/^[-*] (?=\S)/.test(source)) {
          continue
        }
        replacements.set(offset, '*')
        const taskNumber = /^[-*] \[[ xX]\] \d+(\\)\.(?=\s)/.exec(source)
        if (item.checked !== null && item.checked !== undefined && taskNumber) {
          replacements.set(offset + taskNumber[0].length - 2, '')
        }
      }
    }
    if ('children' in node) {
      pending.push(...node.children)
    }
  }
  // Preserve block structure too: changing list markers can join or separate adjacent lists.
  return JSON.stringify([
    description.replace(/[-*\\]/g, (character, offset) => replacements.get(offset) ?? character),
    structure
  ])
}
