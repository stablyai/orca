import { getServeFlagTypoError, getServeOptionGuardError } from '../../shared/serve-option-guards'

export type ServeOptions = {
  json: boolean
  wsPort?: number
  pairingAddress: string | null
  noPairing: boolean
  mobilePairing: boolean
  recipeJson: boolean
  projectRoot: string | null
}

/**
 * Parse and validate headless-serve options from process argv (after
 * `normalizeServeModeArgv`). Shared by the Electron main entry so unit tests
 * can cover the same guards the packaged binary runs (#13006).
 */
export function getServeOptions(argv: readonly string[]): ServeOptions {
  const terminatorIndex = argv.indexOf('--')
  const optionArgv = terminatorIndex === -1 ? argv : argv.slice(0, terminatorIndex)
  // Why: packaged-binary CLI-form serve skips the CLI parser (#13006 / #12818).
  // Reject pairing-flag typos before they silently keep pairing enabled.
  const typoError = getServeFlagTypoError(optionArgv)
  if (typoError) {
    throw new Error(typoError)
  }
  const valueAfter = (flag: string): string | null => {
    const index = optionArgv.indexOf(flag)
    if (index === -1) {
      return null
    }
    const value = optionArgv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}.`)
    }
    return value
  }
  const rawPort = valueAfter('--serve-port')
  let wsPort: number | undefined
  if (rawPort) {
    const parsedPort = Number(rawPort)
    if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
      throw new Error(`Invalid --serve-port value: ${rawPort}`)
    }
    wsPort = parsedPort
  }
  const options: ServeOptions = {
    json: optionArgv.includes('--serve-json'),
    ...(wsPort !== undefined ? { wsPort } : {}),
    pairingAddress: valueAfter('--serve-pairing-address'),
    noPairing: optionArgv.includes('--serve-no-pairing'),
    mobilePairing: optionArgv.includes('--serve-mobile-pairing'),
    recipeJson: optionArgv.includes('--serve-recipe-json'),
    projectRoot: valueAfter('--serve-project-root')
  }
  const guardError = getServeOptionGuardError(options)
  if (guardError) {
    throw new Error(guardError)
  }
  return options
}
