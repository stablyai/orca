/**
 * Argument parsing for the headless `orca-server` entrypoint. Kept electron-free
 * and dependency-free so it can be unit-tested and bundled into the node server.
 */
export type NodeServerOptions = {
  help: boolean
  port?: number
  host?: string
  userDataPath?: string
  pairingAddress?: string
  mobilePairing: boolean
  noPairing: boolean
  json: boolean
}

export function parseServerArgs(argv: string[]): NodeServerOptions {
  const options: NodeServerOptions = {
    help: false,
    mobilePairing: false,
    noPairing: false,
    json: false
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const matchesValueFlag = (flag: string): boolean => arg === flag || arg.startsWith(`${flag}=`)
    const valueAfter = (flag: string): string => {
      const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined
      if (inline !== undefined && inline.length > 0) {
        return inline
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        i += 1
        return next
      }
      throw new Error(`Missing value for ${flag}`)
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--mobile-pairing') {
      options.mobilePairing = true
    } else if (arg === '--no-pairing') {
      options.noPairing = true
    } else if (matchesValueFlag('--serve-port') || matchesValueFlag('--port')) {
      const raw = valueAfter(matchesValueFlag('--port') ? '--port' : '--serve-port')
      const port = Number.parseInt(raw, 10)
      if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid port value: ${raw}`)
      }
      options.port = port
    } else if (matchesValueFlag('--serve-host') || matchesValueFlag('--host')) {
      options.host = valueAfter(matchesValueFlag('--host') ? '--host' : '--serve-host')
    } else if (matchesValueFlag('--user-data') || matchesValueFlag('--user-data-path')) {
      options.userDataPath = valueAfter(
        matchesValueFlag('--user-data-path') ? '--user-data-path' : '--user-data'
      )
    } else if (matchesValueFlag('--pairing-address')) {
      options.pairingAddress = valueAfter('--pairing-address')
    }
  }

  return options
}

export function printNodeServerHelp(): void {
  console.log(`orca-server — headless Orca runtime server

Usage: orca-server [options]

Options:
  --serve-port <port>        WebSocket/RPC port (default 6768; the transport
                             binds 0.0.0.0 so it is reachable externally)
  --pairing-address <host>   Public host/URL to embed in the pairing URL
                             (use when behind NAT / in a container)
  --mobile-pairing           Mint a mobile-scoped pairing offer
  --no-pairing               Start without minting a pairing offer
  --user-data <path>         Persistent data dir (pairings, E2EE keypair,
                             terminal history). Defaults to ORCA_USER_DATA_PATH
                             or the per-platform Orca data dir.
  --json                     Print the ready/pairing payload as JSON on stdout
  -h, --help                 Show this help

Environment:
  ORCA_USER_DATA_PATH        Same as --user-data
  ORCA_APP_VERSION           Reported runtime version
`)
}
