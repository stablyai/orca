import { gtExecFileAsync, type GtExecOptions } from '../git/command-runner/gt-exec-file'

export type GtApiResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

/** gt `api -i` writes the status line and headers to stderr and the body to stdout. */
export function parseGtApiResponse(stdout: string, stderr: string): GtApiResponse {
  const headers: Record<string, string> = {}
  let status = 0
  const lines = stderr.split(/\r?\n/)
  for (const line of lines) {
    if (line.length === 0) {
      break
    }
    const statusMatch = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})\b/i.exec(line)
    if (statusMatch) {
      status = Number(statusMatch[1])
      continue
    }
    const headerMatch = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line)
    if (headerMatch) {
      headers[headerMatch[1].toLowerCase()] = headerMatch[2].trim()
    }
  }
  return { status, headers, body: stdout }
}

export function parseGtPaginationTotal(headers: Record<string, string>): number | undefined {
  const raw = headers['x-total-count']
  if (!raw) {
    return undefined
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

export async function gtApiWithHeaders(
  args: string[],
  options?: GtExecOptions
): Promise<GtApiResponse> {
  const { stdout, stderr } = await gtExecFileAsync(['api', '-i', ...args], options)
  return parseGtApiResponse(stdout, stderr)
}
