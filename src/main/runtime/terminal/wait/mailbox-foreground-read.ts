import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import {
  inspectLaunchedAgentForeground,
  type ForegroundReadArgs,
  type MailboxAgentProcess,
  type MailboxForegroundInspection
} from './launched-agent-foreground'

/** Mail's foreground read: also names the agent in front and, on a local POSIX host, its process. */
export async function readMailboxForeground(
  ...args: ForegroundReadArgs
): Promise<MailboxForegroundInspection> {
  let agent: TuiAgent | undefined
  let process: MailboxAgentProcess | undefined
  const foreground = await inspectLaunchedAgentForeground(
    ...args,
    undefined,
    true,
    (value, row) => {
      agent = value
      process = row
    }
  )
  return foreground === 'agent'
    ? { foreground, agent: agent ?? args[3], ...(process ? { process } : {}) }
    : { foreground }
}
