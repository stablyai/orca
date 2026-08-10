/* eslint-disable no-control-regex -- Why: collapsing raw C0/C1 bytes before they reach a PTY is the entire point of this module. */
/**
 * Compose the message an agent receives when a human stops one of its services.
 *
 * Kept explicit about intent because the failure it prevents is the agent
 * treating the stop as a crash and restarting the service in a loop.
 */
export function buildAgentStopNotice(args: {
  serviceName: string | null
  port: number
  projectName: string | null
}): string {
  const name = args.serviceName ?? `port ${args.port}`
  const where = args.projectName ? ` in ${args.projectName}` : ''
  return (
    `I stopped ${name} (:${args.port})${where} from Orca's Services panel. ` +
    'This was deliberate, not a crash. Do not restart it unless I ask.'
  )
}

/**
 * Terminals submit on carriage return. The notice is written as one line so a
 * multi-line message cannot submit halfway through.
 *
 * Every control byte is collapsed, not just CR and LF: the service and project
 * names come from container image names and on-disk metadata, and an embedded
 * escape sequence would be interpreted by the agent's terminal rather than
 * shown as text. This function is the only place we write to a PTY, so the
 * guard belongs here.
 */
export function toTerminalInput(notice: string): string {
  return `${notice
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()}\r`
}
