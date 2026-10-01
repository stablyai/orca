import { unlinkSync } from 'node:fs'
import { readWindowsBunPtyGateRequest, runWindowsBunPtyGate } from './windows-bun-pty-gate'

async function main(): Promise<void> {
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
