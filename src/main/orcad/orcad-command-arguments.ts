import type { OrcadOptions } from './orcad-start-contract'
import { DEFAULT_WS_PORT } from '../runtime/runtime-rpc/runtime-rpc-pairing-types'
import { ORCAD_LOOPBACK_BIND_HOST } from './orcad-bind-address'
import { getServeOptionValidationError } from '../../shared/serve-option-validation'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { WEB_CLIENT_INDEX_FILENAME } from '../../shared/bundled-web-client-root'

export const ORCAD_USAGE = `orcad — the Orca runtime served without Electron.

Usage: orcad [options]

Options:
  --port <n>               WebSocket port, 0-65535; 0 picks a free port.
                           Defaults to ${DEFAULT_WS_PORT}, with a fallback if unavailable.
  --bind <ip>              Literal IP to bind (default ${ORCAD_LOOPBACK_BIND_HOST}, local only).
                           Use an SSH port-forward or a network IP for remote access.
  --pairing-address <addr> Address advertised in pairing offers when different
                           from the bind address (for example, a public hostname).
  --json                   Print the one-line server readiness JSON to stdout.
  --no-pairing             Do not create a client pairing offer at startup.
  --mobile-pairing         Create a mobile-scoped pairing offer with a QR code.
  --grant-desktop-control  Allow desktop control in the default runtime offer;
                           cannot combine with --no-pairing or --mobile-pairing.
  --recipe-json            Print only the VM recipe line; requires --project-root.
  --project-root <dir>     Existing absolute project directory for --recipe-json.
  --web-client-root <dir>  Serve the browser client from this directory (holds web-index.html).
  --help, -h               Print this text and exit without starting the server.
  --reclaim-stale-lock [--yes]
                           Without starting the server, check whether this data root's
                           instance lock belongs to an orcad that stopped (same host,
                           an earlier boot, nothing answering) and, with --yes, clear it.

Environment:
  ORCA_USER_DATA           Data directory for this instance's profile and state.
`

type OrcadCommandArguments = OrcadOptions & { help?: boolean }

/** Value-taking flags consume the next token even if it resembles another flag. */
export function parseArgs(argv: string[]): OrcadCommandArguments {
  const options: OrcadCommandArguments = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--port') {
      const raw = argv[i + 1]
      const port = Number(raw)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`--port expects an integer 0-65535, got ${raw ?? "''"}`)
      }
      options.port = port
      i += 1
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--no-pairing') {
      options.noPairing = true
    } else if (arg === '--mobile-pairing') {
      options.mobilePairing = true
    } else if (arg === '--grant-desktop-control') {
      options.grantDesktopControl = true
    } else if (arg === '--recipe-json') {
      options.recipeJson = true
    } else if (arg === '--project-root') {
      const value = argv[i + 1]
      if (!value) {
        throw new Error('--project-root expects a value')
      }
      options.projectRoot = value
      i += 1
    } else if (arg === '--bind') {
      const value = argv[i + 1]
      if (value === undefined) {
        throw new Error('--bind expects a value')
      }
      options.bind = value
      i += 1
    } else if (arg === '--web-client-root') {
      const value = argv[i + 1]
      if (!value) {
        throw new Error('--web-client-root expects a value')
      }
      options.webClientRoot = value
      i += 1
    } else if (arg === '--pairing-address') {
      const value = argv[i + 1]
      if (!value) {
        throw new Error('--pairing-address expects a value')
      }
      options.pairingAddress = value
      i += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  const validationError = getServeOptionValidationError({
    noPairing: options.noPairing === true,
    mobilePairing: options.mobilePairing === true,
    grantDesktopControl: options.grantDesktopControl,
    recipeJson: options.recipeJson === true,
    projectRoot: options.projectRoot
  })
  if (validationError) {
    throw new Error(validationError)
  }
  return options
}

/** Reject web roots without an index before pairing can advertise a broken URL. */
export function resolveOrcadWebClientRoot(
  requested: string | undefined,
  warn: (message: string) => void = console.warn
): string | undefined {
  if (!requested) {
    return undefined
  }
  const root = resolve(requested)
  if (!existsSync(join(root, WEB_CLIENT_INDEX_FILENAME))) {
    warn(`[orcad] no ${WEB_CLIENT_INDEX_FILENAME} in ${root}; serving without the browser client`)
    return undefined
  }
  return root
}
