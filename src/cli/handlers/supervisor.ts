/**
 * `orca supervisor print|doctor` — a front door over the generator and audit orcad already
 * exposes as `--print-service` and `--doctor`.
 *
 * These inspect and describe THIS machine. The CLI normally targets a paired runtime that
 * is a different host entirely, so `supervisor` is registered in `shouldIgnoreRemoteSelection`
 * and every answer names the host it looked at — otherwise an operator would read a verdict
 * about their laptop as a verdict about their server.
 */
import { hostname } from 'node:os'
import process from 'node:process'
import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import {
  collectDoctorFindings,
  printService,
  runDoctor
} from '../../main/orcad/orcad-service-command'
import { SupervisorServiceUnsupportedError } from '../../shared/supervisor-service-render'

/** Why translate: an unsupported platform is a bad request, not a CLI crash. */
async function reportingUnsupported<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw error instanceof SupervisorServiceUnsupportedError
      ? new RuntimeClientError('invalid_argument', error.message)
      : error
  }
}

/** Rebuilds the argv the orcad-side parser expects from the CLI's parsed flag map. */
function toServiceArgv(flags: Map<string, string | boolean>, names: string[]): string[] {
  const argv: string[] = []
  for (const name of names) {
    const value = flags.get(name)
    if (value === true) {
      argv.push(`--${name}`)
    } else if (typeof value === 'string') {
      argv.push(`--${name}`, value)
    }
  }
  return argv
}

export const SUPERVISOR_HANDLERS: Record<string, CommandHandler> = {
  'supervisor print': async ({ flags, json }) => {
    // Why refuse rather than ignore: stdout here is a file meant to be redirected, so
    // honouring --json would hand a scripted caller a unit file wrapped in nothing.
    if (json) {
      throw new RuntimeClientError(
        'invalid_argument',
        'supervisor print writes a service definition to stdout, so it has no JSON form. Drop --json.'
      )
    }
    await reportingUnsupported(() =>
      printService(toServiceArgv(flags, ['orcad', 'scope', 'user', 'node', 'port', 'bind']))
    )
  },
  'supervisor doctor': async ({ flags, json }) => {
    const argv = toServiceArgv(flags, ['service-path', 'no-probe'])
    if (json) {
      const { findings, code } = await reportingUnsupported(() => collectDoctorFindings(argv))
      process.stdout.write(`${JSON.stringify({ host: hostname(), findings }, null, 2)}\n`)
      process.exitCode = code
      return
    }
    process.stdout.write(`Inspecting service definitions on ${hostname()} (this machine).\n\n`)
    const code = await reportingUnsupported(() => runDoctor(argv))
    if (code !== 0) {
      process.exitCode = code
    }
  }
}
