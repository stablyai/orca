import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { createOpenCodeTextTaskHttp } from './text-tasks/opencode-text-task-http'

const serviceInfo = z.looseObject({
  url: z.string(),
  password: z.string().optional()
})

async function readOpenCodeServiceInfo(): Promise<z.infer<typeof serviceInfo> | null> {
  try {
    const stateHome = process.env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state')
    const parsed = serviceInfo.safeParse(
      JSON.parse(await readFile(join(stateHome, 'opencode', 'service.json'), 'utf8'))
    )
    if (!parsed.success || parsed.data.url.trim().length === 0) {
      return null
    }
    return { ...parsed.data, url: parsed.data.url.trim() }
  } catch {
    return null
  }
}

/** Queue a pointer into one exact OpenCode session, independent of the TUI's focused session. */
export async function promptOpenCodeSession(sessionId: string, text: string): Promise<boolean> {
  const info = await readOpenCodeServiceInfo()
  if (!info) {
    return false
  }
  const http = createOpenCodeTextTaskHttp(info.url, info.password, '', 'opencode', 'v2')
  try {
    await http.request(
      'POST',
      `/api/session/${encodeURIComponent(sessionId)}/prompt`,
      { text, delivery: 'queue' },
      AbortSignal.timeout(5000)
    )
    return true
  } catch {
    return false
  }
}
