import { realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type {
  PluginMarkdownOutput,
  PluginMarkdownSource
} from '../../shared/plugins/plugin-markdown-renderer'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { isDescendantOrEqual, isENOENT } from '../ipc/filesystem-path-containment'

async function nearestExistingPath(path: string): Promise<string> {
  let current = path
  for (;;) {
    try {
      return await realpath(current)
    } catch (error) {
      const parent = dirname(current)
      if (!isENOENT(error) || parent === current) {
        throw error
      }
      current = parent
    }
  }
}

export async function validatePluginMarkdownReferences(
  source: PluginMarkdownSource,
  output: PluginMarkdownOutput
): Promise<boolean> {
  const cells =
    output.kind === 'table' ? output.rows.flat() : output.kind === 'list' ? output.items : []
  const targets = new Set<string>()
  for (const cell of cells) {
    if (cell.reference) {
      const base =
        cell.reference.base === 'workspace' ? source.workspacePath : dirname(source.documentPath)
      const target = resolve(base, ...cell.reference.path.split('/'))
      if (!isDescendantOrEqual(target, source.workspacePath)) {
        return false
      }
      targets.add(target)
    }
  }
  try {
    const contained = await mapWithConcurrency([...targets], 4, async (target) =>
      isDescendantOrEqual(await nearestExistingPath(target), source.workspacePath)
    )
    return contained.every(Boolean)
  } catch {
    return false
  }
}
