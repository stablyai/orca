#!/usr/bin/env node
import { findCommandSpec, parseArgs, resolveHelpPath, validateCommandAndFlags } from './args'
import { formatCommandHelp, formatGroupHelp } from './help'
import { reportCliError } from './format'
import { RuntimeClientError } from './runtime/types'
import { CHROME_DEVTOOLS_HANDLERS } from './handlers/chrome-devtools'
import { CHROME_DEVTOOLS_COMMAND_SPECS } from './specs/chrome-devtools'

export async function chromeDevtoolsStandaloneMain(
  argv = process.argv.slice(2),
  cwd = process.cwd()
): Promise<void> {
  const args = argv[0] === 'help' ? [...argv.slice(1), '--help'] : argv
  const specs = CHROME_DEVTOOLS_COMMAND_SPECS
  const parsed = parseArgs(
    ['chrome-devtools', ...args],
    specs.map((spec) => spec.path)
  )
  const json = parsed.flags.has('json')
  try {
    const helpPath = resolveHelpPath(parsed)
    if (helpPath || parsed.commandPath.length === 1) {
      const path = helpPath ?? parsed.commandPath
      const spec = findCommandSpec(specs, path)
      if (!spec && path.length !== 1) {
        throw new RuntimeClientError('invalid_argument', `Unknown command: ${path.join(' ')}`)
      }
      const help = spec ? formatCommandHelp(spec) : formatGroupHelp(specs, 'chrome-devtools')
      console.log(help.replaceAll('orca chrome-devtools', 'orca-chrome-devtools'))
      return
    }
    validateCommandAndFlags(specs, parsed)
    await CHROME_DEVTOOLS_HANDLERS[parsed.commandPath.join(' ')]({
      flags: parsed.flags,
      cwd,
      json,
      get client(): never {
        throw new Error('The standalone Chrome DevTools bridge cannot create an Orca RPC client.')
      }
    })
  } catch (error) {
    reportCliError(error, json, { commandPath: parsed.commandPath })
    process.exitCode = 1
  }
}

if (require.main === module) {
  void chromeDevtoolsStandaloneMain()
}
