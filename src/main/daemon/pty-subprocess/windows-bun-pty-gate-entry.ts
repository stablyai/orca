import { unlinkSync } from 'node:fs'
import {
  readWindowsBunConsoleProcessList,
  WINDOWS_BUN_CONSOLE_LIST_ARGUMENT
} from '../../providers/windows-bun-console-process-list'
import { readWindowsBunPtyGateRequest, runWindowsBunPtyGate } from './windows-bun-pty-gate'

async function main(): Promise<void> {
  if (process.argv[2] === WINDOWS_BUN_CONSOLE_LIST_ARGUMENT) {
    const consoleProcessList = readWindowsBunConsoleProcessList(Number(process.argv[3]))
    await new Promise<void>((resolve, reject) => {
      if (!process.send) {
        return reject(new Error('Console query requires an IPC owner'))
      }
      process.send({ consoleProcessList }, (error: Error | null) =>
        error ? reject(error) : resolve()
      )
    })
    process.disconnect?.()
    return
  }
  const requestPath = process.argv[2]
  if (!requestPath) {
    throw new Error('Windows PTY gate request path is required')
  }
  const request = readWindowsBunPtyGateRequest(requestPath)
  // Arguments can contain agent prompts; do not retain them for the shell's lifetime.
  unlinkSync(requestPath)
  process.exitCode = await runWindowsBunPtyGate(request)
}

void main().catch((error: unknown) => {
  console.error(
    '[pty] Windows job gate failed:',
    error instanceof Error ? error.message : String(error)
  )
  process.exitCode = 1
})
