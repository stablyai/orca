import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const PROBE_TIMEOUT_MS = 2_000
const PROBE_MAX_BUFFER = 64 * 1024

export async function collectShellAvailabilitySummary(
  platform: NodeJS.Platform = process.platform
): Promise<Record<string, unknown>> {
  const shells =
    platform === 'win32'
      ? ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'wsl.exe', 'bash.exe']
      : ['sh', 'bash', 'zsh', 'fish', 'pwsh']
  const result: Record<string, boolean> = {}
  await Promise.all(
    shells.map(async (shell) => {
      result[shell] = await isShellAvailable(shell, platform)
    })
  )
  return {
    platform,
    shells: result
  }
}

async function isShellAvailable(shell: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await (platform === 'win32'
      ? execFileAsync('where.exe', [shell], {
          timeout: PROBE_TIMEOUT_MS,
          maxBuffer: PROBE_MAX_BUFFER
        })
      : execFileAsync('sh', ['-lc', `command -v ${quoteShellWord(shell)} >/dev/null 2>&1`], {
          timeout: PROBE_TIMEOUT_MS,
          maxBuffer: PROBE_MAX_BUFFER
        }))
    return true
  } catch {
    return false
  }
}

function quoteShellWord(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
