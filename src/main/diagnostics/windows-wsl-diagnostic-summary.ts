import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { redactString } from '../observability/redactor'

const execFileAsync = promisify(execFile)
const WSL_TIMEOUT_MS = 4_000

export async function collectWindowsWslDiagnosticSummary(): Promise<Record<string, unknown>> {
  if (process.platform !== 'win32') {
    return { supported: false, reason: 'not_windows' }
  }
  const [status, list] = await Promise.all([runWsl(['--status']), runWsl(['--list', '--verbose'])])
  return {
    supported: true,
    status,
    distributions: list
  }
}

async function runWsl(args: string[]): Promise<{ ok: boolean; output?: string; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('wsl.exe', args, {
      timeout: WSL_TIMEOUT_MS,
      maxBuffer: 256 * 1024
    })
    return {
      ok: true,
      output: redactString([stdout, stderr].filter(Boolean).join('\n')).slice(0, 4000)
    }
  } catch (error) {
    return {
      ok: false,
      error: redactString(error instanceof Error ? error.message : String(error)).slice(0, 1000)
    }
  }
}
