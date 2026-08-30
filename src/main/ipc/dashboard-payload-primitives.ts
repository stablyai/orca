/**
 * Shared bounds and scalar guards for the dashboard IPC validators.
 *
 * These sit in their own module because the snapshot, workspace, review and
 * file-link validators each need them, and every copy of a trust-boundary
 * check is a chance for one of them to drift looser than the rest.
 */

import { DASHBOARD_MAX_LABEL_LENGTH } from '../../shared/dashboard-snapshot'

export const MAX_ID_LENGTH = 4_096
export const MAX_LABEL_LENGTH = DASHBOARD_MAX_LABEL_LENGTH

export function isBoundedString(
  value: unknown,
  maxLength: number,
  allowEmpty = false
): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0)
}

export function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || isBoundedString(value, maxLength, true)
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The pop-out hands these straight to the OS opener, so only http(s) passes. */
export function isOptionalWebUrl(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  if (!isBoundedString(value, MAX_ID_LENGTH)) {
    return false
  }
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
