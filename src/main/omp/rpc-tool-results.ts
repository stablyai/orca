import { isRecord } from '../../shared/agent-status-child-work-value-guards'

export type OmpNativeToolResult = {
  details: Record<string, unknown>
  toolName?: string
  path?: string
  returned: boolean
}

/** Eval's printed tool values retain structured JSON even when their text is truncated. */
export function* ompNativeToolResults(
  details: Record<string, unknown>,
  toolName: string | undefined
): Generator<OmpNativeToolResult> {
  const pending: {
    value: unknown
    path?: string
    depth: number
    toolName?: string
    returned: boolean
    isDetails: boolean
  }[] = [{ value: details, toolName, depth: 0, returned: false, isDetails: true }]
  let remaining = 2048
  const enqueueViews = (value: Record<string, unknown>, path: string, depth: number) => {
    if (!Array.isArray(value.cells)) {
      return
    }
    for (let cellIndex = value.cells.length - 1; cellIndex >= 0; cellIndex--) {
      const cell = value.cells[cellIndex]
      if (!isRecord(cell) || !Array.isArray(cell.views)) {
        continue
      }
      for (let viewIndex = cell.views.length - 1; viewIndex >= 0; viewIndex--) {
        const entry = cell.views[viewIndex]
        if (pending.length >= remaining) {
          return
        }
        if (isRecord(entry) && isRecord(entry.view) && entry.view.kind === 'json') {
          pending.push({
            value: entry.view.value,
            path: `${path}:${cellIndex}:${viewIndex}`,
            depth,
            returned: true,
            isDetails: false
          })
        }
      }
    }
  }
  while (remaining-- > 0 && pending.length > 0) {
    const entry = pending.pop()
    if (!entry || entry.depth > 8) {
      continue
    }
    const { value, path, depth, returned } = entry
    if (entry.isDetails && isRecord(value)) {
      yield { details: value, path, returned, toolName: entry.toolName }
      const xdev = value.xdev
      if (
        isRecord(xdev) &&
        xdev.mode === 'execute' &&
        typeof xdev.tool === 'string' &&
        isRecord(xdev.inner) &&
        pending.length < remaining
      ) {
        pending.push({
          value: xdev.inner,
          path: `${path ?? 'root'}:xd`,
          toolName: xdev.tool,
          depth: depth + 1,
          returned,
          isDetails: true
        })
      }
      if (entry.toolName === 'eval' || returned) {
        enqueueViews(value, path ?? 'eval', depth + 1)
      }
      continue
    }
    if (isRecord(value) && isRecord(value.details)) {
      pending.push({ ...entry, value: value.details, isDetails: true })
      continue
    }
    const values = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : []
    for (let index = values.length - 1; index >= 0 && pending.length < remaining; index--) {
      pending.push({
        value: values[index],
        path: `${path}:${index}`,
        depth: depth + 1,
        returned,
        isDetails: false
      })
    }
  }
}
