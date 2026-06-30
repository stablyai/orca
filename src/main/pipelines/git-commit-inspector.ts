import { spawn } from 'child_process'

export type PipelineBranchCommitInspectionInput = {
  cwd: string
  baseRef: string
  branch: string
}

export type PipelineBranchCommitInspectionResult = {
  commitShas: string[]
}

export async function inspectPipelineBranchCommits(
  input: PipelineBranchCommitInspectionInput
): Promise<PipelineBranchCommitInspectionResult> {
  const stdout = await runGit(input.cwd, [
    'log',
    '--format=%H',
    `${input.baseRef}..${input.branch}`
  ])
  return {
    commitShas: stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  }
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(stderr.trim() || `git exited with code ${code}`))
      }
    })
  })
}
