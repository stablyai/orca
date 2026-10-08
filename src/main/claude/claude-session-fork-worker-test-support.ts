import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

/** The fork worker, built as the app builds it. The SDK stays external, so the entry has to sit
 *  where Node can resolve the SDK from: under this checkout's node_modules. */
export async function buildClaudeSessionForkWorkerEntry(): Promise<{
  entry: string
  dispose: () => void
}> {
  mkdirSync(resolve('node_modules/.cache'), { recursive: true })
  const out = mkdtempSync(resolve('node_modules/.cache/claude-fork-entry-'))
  const entry = join(out, 'claude-session-fork-worker-entry.js')
  await build({
    entryPoints: [resolve('src/main/claude/claude-session-fork-worker-entry.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', '@anthropic-ai/claude-agent-sdk'],
    logLevel: 'silent'
  })
  return { entry, dispose: () => rmSync(out, { recursive: true, force: true }) }
}
