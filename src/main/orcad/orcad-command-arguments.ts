import type { OrcadOptions } from './orcad-entry'

/**
 * orcad's flags. A value-taking flag consumes the next token whatever it looks
 * like, so `--bind --json` binds to the literal `--json`; only a missing token
 * is an error. Pinned by orcad-launch-contract.test.ts.
 */
export function parseArgs(argv: string[]): OrcadOptions {
  const options: OrcadOptions = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port') {
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
