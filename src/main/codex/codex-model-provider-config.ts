import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  parseTomlSingleLineStringValue,
  parseTomlStringValue,
  updateTomlLineScanState
} from './config-toml-line-scan'

// Why: only the root setting selects the provider for every OAuth login;
// similarly named keys inside profiles or provider tables are not global pins.
export function readCodexTopLevelModelProvider(config: string): string | null {
  let state = createTomlLineScanState()
  let lineOffset = 0
  for (const line of config.split('\n')) {
    if (isTomlStructuralLine(state)) {
      if (getTomlTableHeader(line)) {
        return null
      }
      const valueOffset = getModelProviderValueOffset(line)
      if (valueOffset !== null) {
        return parseTomlStringValue(config, lineOffset + valueOffset)?.value ?? null
      }
    }
    state = updateTomlLineScanState(state, line)
    lineOffset += line.length + 1
  }
  return null
}

function getModelProviderValueOffset(line: string): number | null {
  let index = 0
  while (line[index] === ' ' || line[index] === '\t') {
    index += 1
  }

  if (line.startsWith('model_provider', index)) {
    index += 'model_provider'.length
  } else {
    const parsedKey = parseTomlSingleLineStringValue(line, index)
    if (parsedKey?.value !== 'model_provider') {
      return null
    }
    index = parsedKey.end
  }

  while (line[index] === ' ' || line[index] === '\t') {
    index += 1
  }
  return line[index] === '=' ? index + 1 : null
}
