import { z } from 'zod'
import type { GitHubProjectTable } from '../../../../shared/github/project-types'
import { defineMethod } from '../core'

// The bridge envelope is 600 KB, and a 500-item project view can exceed it, so the page asks for
// one row window at a time and this handler decides where each window ends.
const MAX_RESULT_BYTES = 512 * 1024

const ProjectTableWindow = z.object({
  owner: z.string().min(1).max(512),
  host: z.string().max(512).optional(),
  ownerType: z.enum(['organization', 'user']),
  projectNumber: z.number().int().positive(),
  viewId: z.string().min(1).max(240),
  queryOverride: z.string().max(4_096).optional(),
  rowOffset: z.number().int().nonnegative().max(100_000).optional()
})

export const MOBILE_WEB_TASK_PROJECT_TABLE_METHOD = defineMethod({
  name: 'mobileWeb.tasks.projectTable',
  params: ProjectTableWindow,
  handler: async (params, context) => {
    const { rowOffset = 0, ...request } = params
    const raw = await context.runtime.getGitHubProjectViewTable(request)
    if (!raw.ok) {
      return raw
    }
    const table = raw.data
    const rows = table.rows
    const window = rowWindow(table, rows, rowOffset)
    if (window === null) {
      return {
        ok: false,
        error: { type: 'too_large', message: 'A project row exceeds the mobile response limit.' }
      }
    }
    const nextRowOffset = rowOffset + window.length
    return {
      ...raw,
      data: { ...table, rows: window },
      ...(nextRowOffset < rows.length ? { nextRowOffset } : {})
    }
  }
})

function rowWindow(
  table: GitHubProjectTable,
  rows: GitHubProjectTable['rows'],
  offset: number
): GitHubProjectTable['rows'] | null {
  const window: GitHubProjectTable['rows'] = []
  for (const row of rows.slice(offset)) {
    window.push(row)
    if (Buffer.byteLength(JSON.stringify({ ...table, rows: window })) > MAX_RESULT_BYTES) {
      window.pop()
      return window.length > 0 ? window : null
    }
  }
  return Buffer.byteLength(JSON.stringify({ ...table, rows: window })) <= MAX_RESULT_BYTES
    ? window
    : null
}
