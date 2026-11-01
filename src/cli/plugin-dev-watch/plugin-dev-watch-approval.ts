import { createInterface } from 'node:readline'
import { z } from 'zod'
import { formatPluginGrantLines } from '../plugin-authoring/plugin-grant-lines'
import { RuntimeClientError } from '../runtime/types'
import type { DevLoadResult } from '../handlers/plugin-runtime'

/** Asks a yes/no question; false on anything but yes, end of input or Ctrl-C. */
export type PluginDevWatchConfirm = (question: string) => Promise<boolean>

const firstLoadApprovalSchema = z.object({
  pluginKey: z.string(),
  name: z.string(),
  version: z.string(),
  approvalFingerprint: z.string(),
  why: z.string().optional(),
  grants: z.object({
    execution: z.string(),
    executionDescription: z.string(),
    capabilities: z.array(z.object({ description: z.string() })),
    contributions: z.array(z.object({ kind: z.string(), name: z.string() }))
  })
})

type FirstLoadApproval = z.infer<typeof firstLoadApprovalSchema>

function firstLoadApprovalOf(error: unknown): FirstLoadApproval | null {
  // Why not `approval_stale`: it answers a fingerprint passed with --approve, which stays explicit.
  if (!(error instanceof RuntimeClientError) || error.code !== 'approval_required') {
    return null
  }
  const parsed = firstLoadApprovalSchema.safeParse(error.data)
  return parsed.success ? parsed.data : null
}

export function pluginDevWatchApprovalQuestion(approval: FirstLoadApproval): string {
  return [
    `${approval.name} needs your approval before Orca runs it. Approving grants:`,
    ...formatPluginGrantLines(approval),
    ...(approval.why ? [approval.why] : []),
    'Approve and load? [y/N] '
  ].join('\n')
}

/** The first dev load; with `confirm` (a person at a terminal) an approval is asked, never assumed.
 *  A declined or unanswered ask rethrows the host's error, which prints the re-run command. */
export async function devLoadWithApproval(
  devLoad: (approvalFingerprint?: string) => Promise<DevLoadResult>,
  confirm: PluginDevWatchConfirm | undefined
): Promise<DevLoadResult> {
  try {
    return await devLoad()
  } catch (error) {
    const approval = confirm ? firstLoadApprovalOf(error) : null
    if (!confirm || !approval || !(await confirm(pluginDevWatchApprovalQuestion(approval)))) {
      throw error
    }
    return devLoad(approval.approvalFingerprint)
  }
}

type PromptStreams = {
  input: NodeJS.ReadableStream & { isTTY?: boolean }
  output: NodeJS.WritableStream & { isTTY?: boolean }
}

/** A prompt only for a person at a terminal; agents, pipes and `--json` keep the exit-3 error. */
export function pluginDevWatchConfirmFor(
  json: boolean,
  streams: PromptStreams = { input: process.stdin, output: process.stdout }
): PluginDevWatchConfirm | undefined {
  return !json && streams.input.isTTY && streams.output.isTTY
    ? createTerminalConfirm(streams)
    : undefined
}

/** readline works the same in Windows cmd, PowerShell and Windows Terminal as on POSIX ttys. */
export function createTerminalConfirm(streams: PromptStreams): PluginDevWatchConfirm {
  return (question) =>
    new Promise((resolve) => {
      const rl = createInterface({ input: streams.input, output: streams.output })
      let answered = false
      const finish = (yes: boolean): void => {
        if (answered) {
          return
        }
        answered = true
        rl.close()
        resolve(yes)
      }
      // Why: with no SIGINT listener readline only pauses on Ctrl-C, leaving the prompt hanging.
      rl.on('SIGINT', () => {
        streams.output.write('\n')
        finish(false)
      })
      rl.on('close', () => {
        if (!answered) {
          streams.output.write('\n')
        }
        finish(false)
      })
      rl.question(question, (answer) => finish(/^y(es)?$/i.test(answer.trim())))
    })
}
