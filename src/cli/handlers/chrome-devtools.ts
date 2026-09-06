import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { runChromeDevtoolsSession } from '../../main/agent-mcp/chrome-devtools-session'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import {
  callChromeDevtoolsTool,
  listChromeDevtoolsTools
} from '../../main/agent-mcp/chrome-devtools-bridge'

function rejectRemoteInvocation(flags: Map<string, string | boolean>): void {
  rejectRemoteSelectionFlags(flags, 'Chrome DevTools; run directly on the agent execution host.')
  if (
    flags.has('host') ||
    process.env.ORCA_CLI_CWD ||
    process.env.ORCA_ENVIRONMENT ||
    process.env.ORCA_PAIRING_CODE
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Chrome DevTools requires a direct local invocation without remote routing flags or ORCA_CLI_CWD/ORCA_ENVIRONMENT/ORCA_PAIRING_CODE.'
    )
  }
}

async function readArguments(
  value: string | boolean | undefined,
  cwd: string
): Promise<Record<string, unknown>> {
  if (value === undefined) {
    return {}
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new RuntimeClientError('invalid_argument', 'Provide a path for --arguments-file.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(resolve(cwd, value), 'utf8'))
  } catch (error) {
    throw new RuntimeClientError('invalid_argument', `Cannot read tool arguments: ${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RuntimeClientError('invalid_argument', 'Tool arguments must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

export const CHROME_DEVTOOLS_HANDLERS: Record<string, CommandHandler> = {
  'chrome-devtools session': async ({ flags }) => {
    rejectRemoteInvocation(flags)
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
    const interrupt = (): void => lines.close()
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', interrupt)
    try {
      await runChromeDevtoolsSession(lines, (response) => {
        console.log(JSON.stringify(response))
        if (!response.ok) {
          process.exitCode = 1
        }
      })
    } finally {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', interrupt)
      lines.close()
    }
  },
  'chrome-devtools tools': async ({ flags, json }) => {
    rejectRemoteInvocation(flags)
    const result = await listChromeDevtoolsTools()
    printResult({ id: 'local', ok: true, result, _meta: { runtimeId: 'local' } }, json, (value) =>
      JSON.stringify(value, null, 2)
    )
  },
  'chrome-devtools call': async ({ flags, json, cwd }) => {
    rejectRemoteInvocation(flags)
    const tool = flags.get('tool')
    if (typeof tool !== 'string' || !tool.trim()) {
      throw new RuntimeClientError('invalid_argument', 'Provide --tool <name>.')
    }
    const args = await readArguments(flags.get('arguments-file'), cwd)
    const result = await callChromeDevtoolsTool(tool, args)
    printResult({ id: 'local', ok: true, result, _meta: { runtimeId: 'local' } }, json, (value) =>
      JSON.stringify(value, null, 2)
    )
    if (result.isError) {
      process.exitCode = 1
    }
  }
}
