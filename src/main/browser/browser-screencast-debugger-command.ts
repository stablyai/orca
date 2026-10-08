import type { WebContents } from 'electron'
import { sendGuestCdpCommand } from './guest-cdp-command'

const DEBUGGER_COMMAND_TIMEOUT_MS = 8_000

export function sendDebuggerCommand(
  dbg: WebContents['debugger'],
  method: string,
  params: Record<string, unknown> = {},
  webContents?: WebContents
): Promise<unknown> {
  return runDebuggerCommandWithTimeout(method, () =>
    webContents
      ? sendGuestCdpCommand(webContents, method, params)
      : Promise.resolve().then(() => dbg.sendCommand(method, params))
  )
}

export async function runDebuggerCommandWithTimeout(
  method: string,
  send: () => Promise<unknown>
): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      Promise.resolve().then(send),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out while running ${method}.`))
        }, DEBUGGER_COMMAND_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}
