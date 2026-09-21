import {
  getServeFlagTypoError,
  getServeOptionValidationError
} from '../../shared/serve-option-validation'

export type ServeOptions = {
  json: boolean
  wsPort?: number
  pairingAddress: string | null
  noPairing: boolean
  mobilePairing: boolean
  recipeJson: boolean
  projectRoot: string | null
}

function optionsBeforeTerminator(argv: readonly string[]): readonly string[] {
  const terminatorIndex = argv.indexOf('--')
  return terminatorIndex === -1 ? argv : argv.slice(0, terminatorIndex)
}

function optionName(token: string): string {
  const equalsIndex = token.indexOf('=')
  return equalsIndex === -1 ? token : token.slice(0, equalsIndex)
}

function lastValueOccurrence(
  argv: readonly string[],
  flags: readonly string[]
): string | null | undefined {
  const flagNames = new Set(flags)
  let value: string | null | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    const name = optionName(token)
    if (!flagNames.has(name)) {
      continue
    }

    const equalsIndex = token.indexOf('=')
    if (equalsIndex !== -1) {
      const assigned = token.slice(equalsIndex + 1)
      value = assigned || null
      continue
    }

    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      value = next || null
      index += 1
    } else {
      value = null
    }
  }
  return value
}

function valueAfter(
  argv: readonly string[],
  flags: readonly string[],
  required: boolean,
  displayFlag: string
): string | null {
  const value = lastValueOccurrence(argv, flags)
  if (value === undefined || value === null) {
    if (required && value !== undefined) {
      throw new Error(`Missing value for ${displayFlag}.`)
    }
    return null
  }
  return value
}

function lastBooleanValue(argv: readonly string[], flags: readonly string[]): boolean {
  const flagNames = new Set(flags)
  let value = false
  for (const token of argv) {
    const name = optionName(token)
    if (!flagNames.has(name)) {
      continue
    }
    // CLI boolean flags are true only in bare form; `--flag=...` is a string value.
    value = !token.includes('=')
  }
  return value
}

function hasFlag(argv: readonly string[], flags: readonly string[]): boolean {
  const flagNames = new Set(flags)
  return argv.some((token) => flagNames.has(optionName(token)))
}

export function getServeOptions(argv: readonly string[]): ServeOptions {
  const optionsArgv = optionsBeforeTerminator(argv)
  const typoError = getServeFlagTypoError(optionsArgv)
  if (typoError) {
    throw new Error(typoError)
  }

  const rawPort = valueAfter(optionsArgv, ['--serve-port', '--port'], true, '--serve-port')
  let wsPort: number | undefined
  if (rawPort) {
    const parsedPort = Number(rawPort)
    if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
      throw new Error(`Invalid --serve-port value: ${rawPort}`)
    }
    wsPort = parsedPort
  }

  const options: ServeOptions = {
    // The CLI uses `flags.has('json')`, so even `--json=false` enables JSON output.
    json: hasFlag(optionsArgv, ['--serve-json', '--json']),
    ...(wsPort !== undefined ? { wsPort } : {}),
    pairingAddress: valueAfter(
      optionsArgv,
      ['--serve-pairing-address', '--pairing-address'],
      false,
      '--serve-pairing-address'
    ),
    noPairing: lastBooleanValue(optionsArgv, ['--serve-no-pairing', '--no-pairing']),
    mobilePairing: lastBooleanValue(optionsArgv, ['--serve-mobile-pairing', '--mobile-pairing']),
    recipeJson: lastBooleanValue(optionsArgv, ['--serve-recipe-json', '--recipe-json']),
    projectRoot: valueAfter(
      optionsArgv,
      ['--serve-project-root', '--project-root'],
      false,
      '--serve-project-root'
    )
  }
  const validationError = getServeOptionValidationError(options)
  if (validationError) {
    throw new Error(validationError)
  }
  return options
}
