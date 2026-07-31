import {
  assertJsonTextStructureWithinLimits,
  JsonTextStructureCapacityError,
  type JsonTextStructureLimits
} from '../../../src/shared/json-text-structure-limit'

export const MOBILE_JSON_TEXT_STRUCTURE_LIMITS: JsonTextStructureLimits = {
  structuralTokens: 1_000_000,
  nestingDepth: 128
}

export function parseMobileJsonTextWithinLimits<T = unknown>(
  content: string,
  limits: JsonTextStructureLimits = MOBILE_JSON_TEXT_STRUCTURE_LIMITS
): T {
  assertJsonTextStructureWithinLimits(content, limits)
  return JSON.parse(content) as T
}

export function isMobileJsonStructureCapacityError(
  error: unknown
): error is JsonTextStructureCapacityError {
  return error instanceof JsonTextStructureCapacityError
}

export function tryParseMobileJsonTextWithinLimits<T = unknown>(
  content: string,
  limits: JsonTextStructureLimits = MOBILE_JSON_TEXT_STRUCTURE_LIMITS
): T | null {
  try {
    return parseMobileJsonTextWithinLimits<T>(content, limits)
  } catch (error) {
    if (isMobileJsonStructureCapacityError(error)) {
      throw error
    }
    return null
  }
}
