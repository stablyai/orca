import type { OrcadOptions } from './orcad-entry'

export const ORCAD_USAGE = `orcad — the Orca runtime served without Electron.

Usage: orcad [options]

Options:
  --port <n>               Port to listen on; 0 picks a free one (default 0).
  --bind <ip>              Interface to bind. Defaults to 127.0.0.1 (this machine
                           only); pass 0.0.0.0 or a LAN/Tailscale address to reach
                           orcad from other machines — including mobile clients.
  --pairing-address <addr> Address advertised in pairing offers when it differs
                           from the bind address (e.g. a public hostname).
  --json                   Print the one-line orca_server_ready JSON to stdout
                           once listening (machine-readable boot payload).
  --no-pairing             Do not mint a runtime pairing offer at boot.
  --mobile-pairing         Mint a mobile-scoped pairing offer (terminal QR).
  --grant-desktop-control  Widen the default runtime offer so the pairing client
                           may drive desktop control.
  --recipe-json            Print only the ephemeral-VM recipe line; requires
                           --project-root.
  --project-root <dir>     Project root for --recipe-json.
  --help, -h               Print this text and exit.

Environment:
  ORCA_USER_DATA           Data directory for this instance's profile and state.
`

/**
 * orcad's flags. A value-taking flag consumes the next token whatever it looks
 * like, so `--bind --json` binds to the literal `--json`; only a missing token
 * is an error. Pinned by orcad-launch-contract.test.ts.
 */
export function parseArgs(argv: string[]): OrcadOptions {
  const options: OrcadOptions = {}
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
  if (options.grantDesktopControl && (options.noPairing || options.mobilePairing)) {
    throw new Error('--grant-desktop-control applies only to the default runtime pairing offer')
  }
  if (options.recipeJson && !options.projectRoot) {
    throw new Error('--recipe-json requires --project-root')
  }
  return options
}
