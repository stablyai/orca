import { runProcess } from '@orca/process-host'

export type ZotzProcessResult = { code: number | null; stdout: string; stderr: string }

export type ZotzProcessRunner = (
  program: string,
  args: readonly string[],
  timeoutMs?: number
) => Promise<ZotzProcessResult>

/** Never throws: a missing binary or a timeout comes back as `code: null`. */
export const runZotzProcess: ZotzProcessRunner = async (program, args, timeoutMs = 30_000) => {
  try {
    const result = await runProcess({ program, args, timeoutMs })
    return {
      code: result.timedOut ? null : result.code,
      stdout: result.stdout,
      stderr: result.stderr
    }
  } catch (error) {
    return {
      code: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error)
    }
  }
}

export function processOutput(result: ZotzProcessResult): string {
  return `${result.stdout}${result.stderr}`.trim()
}
