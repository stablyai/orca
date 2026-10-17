import { RuntimeClientError } from './runtime-client-error'

export type MacOSProviderPermissionStatus = {
  accessibility: 'granted' | 'not-granted'
  screenshots: 'granted' | 'not-granted'
}

function parseGrant(value: unknown): 'granted' | 'not-granted' | null {
  return value === 'granted' || value === 'not-granted' ? value : null
}

export function parse(raw: unknown): MacOSProviderPermissionStatus {
  const isObject = typeof raw === 'object' && raw !== null
  const accessibility = parseGrant(isObject && 'accessibility' in raw ? raw.accessibility : null)
  const screenshots = parseGrant(isObject && 'screenshots' in raw ? raw.screenshots : null)
  // Why: a garbled reply is not evidence of a grant or a denial.
  if (!accessibility || !screenshots) {
    throw new RuntimeClientError(
      'accessibility_error',
      'native macOS provider returned a malformed permission status'
    )
  }
  return { accessibility, screenshots }
}
