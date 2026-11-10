import {
  terminalAutoRestoreFitRead,
  terminalAutoRestoreFitSave
} from './mobile-terminal-operations'

export type TerminalAutoRestoreFitByHost = Record<string, number | null | undefined>

type TerminalAutoRestoreFitSender = Parameters<typeof terminalAutoRestoreFitRead.request>[0]

export async function readTerminalAutoRestoreFitMs(
  client: TerminalAutoRestoreFitSender
): Promise<number | null> {
  const reply = terminalAutoRestoreFitRead.interpret(
    await terminalAutoRestoreFitRead.request(client)
  )
  return reply?.ms ?? null
}

export async function saveTerminalAutoRestoreFitMs(
  client: TerminalAutoRestoreFitSender,
  ms: number | null
): Promise<number | null> {
  const reply = terminalAutoRestoreFitSave.interpret(
    await terminalAutoRestoreFitSave.request(client, { ms })
  )
  return reply ? reply.ms : readTerminalAutoRestoreFitMs(client)
}

export function setTerminalAutoRestoreFitMsForHost(
  current: TerminalAutoRestoreFitByHost,
  hostId: string,
  value: number | null
): TerminalAutoRestoreFitByHost {
  if (current[hostId] === value) {
    return current
  }
  return { ...current, [hostId]: value }
}
