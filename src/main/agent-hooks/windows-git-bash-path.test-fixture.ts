import { existsSync } from 'node:fs'
import { join } from 'node:path'

// MSYS rewrites paths and switches, so Windows hook tests also exercise Git Bash.
export function findGitBash(): string {
  if (process.env.KIMI_SHELL_PATH) {
    return process.env.KIMI_SHELL_PATH
  }
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] &&
      join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
  ]
  const bash = candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate))
  )
  if (!bash) {
    throw new Error('Git Bash is required for the Windows managed hook tests')
  }
  return bash
}
