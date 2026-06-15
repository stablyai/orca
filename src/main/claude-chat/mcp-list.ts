import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

type RunFn = (cmd: string, args: string[], opts: { cwd: string }) => Promise<{ stdout: string }>

function defaultRun(
  cmd: string,
  args: string[],
  opts: { cwd: string }
): Promise<{ stdout: string }> {
  return execFileAsync(cmd, args, { cwd: opts.cwd })
}

// Why: parse server names only — UI callers need the list to populate a picker,
// not the full connection details which vary by transport type.
function parseServerNames(stdout: string): string[] {
  const lines = stdout.split('\n')
  const names: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('No MCP servers')) {
      continue
    }
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) {
      continue
    }
    const name = trimmed.slice(0, colonIdx).trim()
    if (name) {
      names.push(name)
    }
  }
  return names
}

export async function listMcpServers(cwd: string, run: RunFn = defaultRun): Promise<string[]> {
  try {
    const { stdout } = await run('claude', ['mcp', 'list'], { cwd })
    return parseServerNames(stdout)
  } catch {
    // Why: missing claude CLI or no config is not fatal for the UI — return empty.
    return []
  }
}
