// What a benchmark report states besides pass counts: the agent CLI it ran, and how sure a rate is.
import { runProcess } from '@orca/process-host'
import type { EvalAgent } from '../bot-automation-eval/bot-automation-eval-host'

/** The agent CLI's own version line, so two reports are compared only on the same build. */
export async function agentVersion(agent: EvalAgent): Promise<string> {
  const result = await runProcess({
    program: agent,
    args: ['--version'],
    stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs: 30_000
  }).catch(() => null)
  return result?.stdout.trim().split('\n')[0] || 'version unknown'
}

/** The 95% Wilson interval of a pass rate, in whole percent; a handful of runs gives a wide one. */
export function wilson(passed: number, total: number): [number, number] {
  if (total === 0) {
    return [0, 100]
  }
  const z = 1.96
  const p = passed / total
  const center = p + (z * z) / (2 * total)
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))
  const scale = 1 + (z * z) / total
  return [
    Math.round((100 * (center - margin)) / scale),
    Math.round((100 * (center + margin)) / scale)
  ]
}
