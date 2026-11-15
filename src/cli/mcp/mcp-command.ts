import { runProcess } from '@orca/process-host'
import { dirname } from 'node:path'
import type { CommandHandler } from '../dispatch/dispatch'
import { readOrcaCliVersion } from '../cli-version'
import { getPackagedElectronExecutable } from '../runtime/app-launch/packaged-cli-interpreter'
import { CLI_GLOBAL_VALUE_FLAGS } from '../../shared/cli/cli-argument-boundary'
import { serveMcpOverStdio, type McpToolRunner } from './mcp-stdio-server'

// Each tool re-runs this same CLI build, so tool results and errors stay identical to `orca ... --json`.
function createCliToolRunner(cwd: string, globalArgs: readonly string[]): McpToolRunner {
  const script = process.argv[1]
  const env: NodeJS.ProcessEnv = { ...process.env }
  // The packaged macOS launcher hands this over once and the interpreter clears it; children need it too.
  const packagedElectron = getPackagedElectronExecutable()
  if (packagedElectron) {
    env.ORCA_CLI_ELECTRON_EXECUTABLE = packagedElectron
  }
  return async (tool, argv, signal) => {
    // No input: the child's stdin is closed, so it can never read the MCP stream.
    const result = await runProcess({
      program: process.execPath,
      args: [...process.execArgv, script, ...globalArgs, ...argv],
      cwd,
      env,
      timeoutMs: tool.maxRuntimeMs ?? null,
      signal
    })
    return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr }
  }
}

export const MCP_HANDLERS: Record<string, CommandHandler> = {
  mcp: async ({ flags, cwd }) => {
    const globalArgs = CLI_GLOBAL_VALUE_FLAGS.flatMap((flag) => {
      const value = flags.get(flag)
      return typeof value === 'string' ? [`--${flag}=${value}`] : []
    })
    await serveMcpOverStdio({
      input: process.stdin,
      output: process.stdout,
      runTool: createCliToolRunner(cwd, globalArgs),
      version: readOrcaCliVersion(dirname(process.argv[1])) ?? '0.0.0'
    })
  }
}
