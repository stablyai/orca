import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

// MSYS rewrites paths and switches, so Windows hook tests also exercise Git Bash.
export function findGitBash(): string {
  if (process.env.KIMI_SHELL_PATH) {
    return process.env.KIMI_SHELL_PATH
  }
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] &&
      join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA &&
      join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    // Custom install locations never appear above; PATH may name them. Entries
    // mentioning git skip the WSL and Store shims that shadow bash.exe on PATH.
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .map((entry) => entry.trim().replace(/^"|"$/g, ''))
      .filter((entry) => /git/i.test(entry))
      .map((entry) => join(entry, 'bash.exe'))
  ]
  const bash = candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate))
  )
  if (!bash) {
    throw new Error('Git Bash is required for the Windows managed hook tests')
  }
  return bash
}
