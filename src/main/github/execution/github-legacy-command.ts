import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Repo-scoped operations need the WSL-aware runner; this legacy wrapper serves generic commands.
export const execFileAsync = promisify(execFile)
