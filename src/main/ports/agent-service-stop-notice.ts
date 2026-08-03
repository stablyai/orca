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
 */
export function toTerminalInput(notice: string): string {
  return `${notice.replace(/[\r\n]+/g, ' ').trim()}\r`
}
