import { basename, delimiter, dirname, isAbsolute } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { fromMsysPath, resolveCodexProbePath } from './codex-hook-flag-table'

/**
 * The codex a launch's request names, when main finds that binary itself:
 * Orca's own codex, or a codex in a folder on main's hydrated PATH. Null for
 * any other path, which is then never run: a request is text any process can write.
 */
export function admitRequestedCodexPath(
  requested: string | null,
  mainPath: string,
  pathEnv: string = process.env.PATH ?? ''
): string | null {
  const codexPath = requested ? fromMsysPath(requested) : null
  const probePath = codexPath && isAbsolute(codexPath) ? resolveCodexProbePath(codexPath) : null
  if (!probePath || !/^codex(\.(exe|cmd))?$/i.test(basename(probePath))) {
    return null
  }
  const same = (left: string, right: string): boolean =>
    normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
  const folder = dirname(probePath)
  const onPath = pathEnv
    .split(delimiter)
    .some((entry) => isAbsolute(entry.trim()) && same(entry.trim(), folder))
  return onPath || same(probePath, mainPath) ? probePath : null
}
