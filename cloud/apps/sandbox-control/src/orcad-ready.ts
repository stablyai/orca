// The pairing offer is a bearer credential for the VM's orcad. Vercel keeps a command's stdout as
// retrievable logs (GET .../cmd/:id/logs, found live), but not its env and not files read back, so
// orca-sandbox-start prints only where the offer is and the control plane reads it with the files
// API. Images that predate this still print the offer itself; both shapes are accepted.
import type { SandboxProviderApi } from './sandbox-provider'

/** Asks orca-sandbox-start to print a pointer line instead of the offer. */
export const READY_VIA_FILE_ENV = { ORCA_READY_VIA: 'file' } as const

const READY_FILE = /^\/(?:[A-Za-z0-9._-]+\/)*ready\.json$/

/** The offer object from the start command's last stdout line, reading it from the VM when pointed to. */
export async function resolveOrcadReadyLine(
  provider: Pick<SandboxProviderApi, 'readFile'>,
  sessionId: string,
  lastLine: string
): Promise<unknown> {
  const line: unknown = JSON.parse(lastLine)
  if (!isPointer(line)) {
    return line
  }
  if (!READY_FILE.test(line.readyFile) || line.readyFile.split('/').includes('..')) {
    throw new Error('orcad ready pointer names an unexpected path')
  }
  const content = await provider.readFile(sessionId, line.readyFile)
  const offer = content?.trim().split('\n').at(-1)
  if (!offer) {
    throw new Error('orcad ready file is empty')
  }
  return JSON.parse(offer)
}

function isPointer(value: unknown): value is { readyFile: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readyFile?: unknown }).readyFile === 'string'
  )
}
