import { RuntimeClientError } from '../runtime-client-error'
import type { BridgeRequest } from './desktop-script-provider-types'

export function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `missing ${key}`)
  }
  return value
}

export function optionalStringParam(
  params: Record<string, unknown>,
  key: string
): string | undefined {
  const value = params[key]
  return typeof value === 'string' ? value : undefined
}

export function optionalNumberParam(
  params: Record<string, unknown>,
  key: string
): number | undefined {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function screenshotRequestParams(
  params: Record<string, unknown>
): Pick<
  BridgeRequest,
  'noScreenshot' | 'screenshotFormat' | 'screenshotScale' | 'screenshotMaxEdge'
> {
  return {
    noScreenshot: params.noScreenshot === true,
    screenshotFormat: params.screenshotFormat === 'jpeg' ? 'jpeg' : undefined,
    screenshotScale: optionalNumberParam(params, 'screenshotScale'),
    screenshotMaxEdge: optionalNumberParam(params, 'screenshotMaxEdge')
  }
}
