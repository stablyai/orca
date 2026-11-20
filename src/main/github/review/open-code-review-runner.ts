import { runProcess } from '@orca/process-host'

export type OpenCodeReviewMode = 'delegate' | 'native'

export type OpenCodeReviewRequest = {
  workdir: string
  mode?: OpenCodeReviewMode
  base?: string
  timeoutMs?: number
}

export type OpenCodeReviewVerdict = 'pass' | 'needs_changes'

export type OpenCodeReviewResult = {
  verdict: OpenCodeReviewVerdict
  report: string
  args: readonly string[]
}

function verdictFromOutput(output: string): OpenCodeReviewVerdict {
  const text = output.toLowerCase()
  if (
    text.includes('needs changes') ||
    text.includes('request changes') ||
    text.includes('blocking')
  ) {
    return 'needs_changes'
  }
  return 'pass'
}

export async function runOpenCodeReview(
  request: OpenCodeReviewRequest
): Promise<OpenCodeReviewResult> {
  const mode = request.mode ?? 'delegate'
  const args =
    mode === 'native'
      ? ['review', '--base', request.base ?? 'HEAD~1']
      : ['review', '--delegate', '--base', request.base ?? 'HEAD~1']
  const result = await runProcess({
    program: 'ocr',
    args,
    cwd: request.workdir,
    timeoutMs: request.timeoutMs ?? 300_000
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  if (result.code !== 0) {
    return { verdict: 'needs_changes', report: output, args }
  }
  return { verdict: verdictFromOutput(output), report: output, args }
}
