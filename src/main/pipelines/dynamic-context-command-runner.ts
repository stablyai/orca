import { spawn } from 'child_process'
import type {
  PipelineDynamicContextCommandInput,
  PipelineDynamicContextCommandResult
} from './prompt-renderer'

export async function runDynamicContextCommand(
  input: PipelineDynamicContextCommandInput
): Promise<PipelineDynamicContextCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, input.timeoutMs)

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.length > input.maxStdoutChars) {
        stdout = stdout.slice(0, input.maxStdoutChars)
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > input.maxStderrChars) {
        stderr = stderr.slice(0, input.maxStderrChars)
      }
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      resolve({ exitCode: null, timedOut, stdout, stderr: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      resolve({ exitCode: timedOut ? null : code, timedOut, stdout, stderr })
    })
  })
}
