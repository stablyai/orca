#!/usr/bin/env node
import {
  findCommandSpec,
  isCommandGroup,
  parseArgs,
  resolveHelpPath,
  validateCommandAndFlags
} from './args'
import { dispatch } from './dispatch'
import { reportCliError } from './format'
import { printHelp } from './help'
import { RuntimeClient } from './runtime-client'
import { COMMAND_SPECS } from './specs'

export { COMMAND_SPECS } from './specs'
export { buildCurrentWorktreeSelector, normalizeWorktreeSelector } from './selectors'

export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const parsed = parseArgs(argv)
  const helpPath = resolveHelpPath(parsed)
  if (helpPath !== null) {
    printHelp(COMMAND_SPECS, helpPath)
    if (
      helpPath.length > 0 &&
      !findCommandSpec(COMMAND_SPECS, helpPath) &&
      !isCommandGroup(helpPath)
    ) {
      process.exitCode = 1
    }
    return
  }
  if (parsed.commandPath.length === 0) {
    printHelp(COMMAND_SPECS, [])
    return
  }
  const json = parsed.flags.has('json')

  try {
    // Why: CLI syntax and flag errors should be reported before any runtime
    // lookup so users do not get misleading "Orca is not running" failures for
    // simple command typos or unsupported flags.
    validateCommandAndFlags(COMMAND_SPECS, parsed)
    const client = new RuntimeClient()
    await dispatch(parsed.commandPath, {
      flags: parsed.flags,
      client,
      cwd,
      json
    })
  } catch (error) {
    reportCliError(error, json)
    process.exitCode = 1
  }
}

if (require.main === module) {
  void main()
}
