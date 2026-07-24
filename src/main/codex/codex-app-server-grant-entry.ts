// Forked (ELECTRON_RUN_AS_NODE) child that runs one codex app-server
// trust-grant session. The parent blocks on spawnSync because hook
// install/refresh must finish before a Codex pane launch proceeds, while the
// JSONL RPC session itself needs a live event loop. Reads the request JSON
// from stdin, writes a single result-envelope JSON line to stdout, and never
// imports electron (see PLAIN_NODE_ENTRY_NAMES in the build guard).
import {
  buildGrantEntryEnvelope,
  type CodexAppServerEntryRequest
} from './codex-app-server-grant-envelope'
import { writeSync } from 'node:fs'
import { runCodexHookTrustGrantSession } from './codex-app-server-client'
import { runCodexUserHookTrustRebaseSession } from './codex-user-hook-trust-rebase-client'

const HARD_EXIT_MARGIN_MS = 2_000

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const raw = await readStdin()
  let request: CodexAppServerEntryRequest
  try {
    request = JSON.parse(raw) as CodexAppServerEntryRequest
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        errorName: 'Error',
        message: `invalid trust-grant request JSON: ${error instanceof Error ? error.message : String(error)}`
      })}\n`
    )
    return
  }
  // Why: backstop for a session whose own deadline failed to fire (clock
  // suspend mid-session); exiting closes the codex child's stdio so it
  // exits on EOF instead of orphaning.
  const hardExit = setTimeout(() => {
    // Why: process.exit() does not flush asynchronous stdout pipes; write the
    // timeout envelope synchronously so the parent can classify the fallback.
    writeSync(
      process.stdout.fd,
      `${JSON.stringify({
        ok: false,
        errorName: 'CodexAppServerTimeoutError',
        message: `trust-grant entry hard deadline (${request.invocation.timeoutMs + HARD_EXIT_MARGIN_MS}ms) elapsed`
      })}\n`
    )
    process.exit(3)
  }, request.invocation.timeoutMs + HARD_EXIT_MARGIN_MS)
  const run =
    'operation' in request
      ? runCodexUserHookTrustRebaseSession(request)
      : runCodexHookTrustGrantSession(request)
  const envelope = await buildGrantEntryEnvelope(run)
  clearTimeout(hardExit)
  process.stdout.write(`${JSON.stringify(envelope)}\n`)
}

void main().then(
  () => {
    process.exitCode = 0
  },
  (error: unknown) => {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        errorName: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error)
      })}\n`
    )
    process.exitCode = 0
  }
)
