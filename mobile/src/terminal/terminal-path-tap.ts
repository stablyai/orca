import {
  parseFileLinkLocation,
  type ParsedFileLinkLocation
} from '../../../src/shared/file-link-location'

export type TappedFilePath = ParsedFileLinkLocation

export function parsePathWithOptionalLineColumn(value: string): TappedFilePath | null {
  const parsed = parseFileLinkLocation(value)
  if (!parsed) {
    return null
  }
  const { pathText, line, column } = parsed
  if (pathText.endsWith('/') || pathText.endsWith('\\')) {
    return null
  }
  return { pathText, line, column }
}
