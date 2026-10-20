import { resolve } from 'node:path'
import { getServeTlsOptionValidationError } from '../../shared/serve-option-validation'
import { RuntimeClientError } from './types'

export type ServeNetworkFlags = {
  bind?: string | null
  allowIp?: string | null
  tlsCert?: string | null
  tlsKey?: string | null
}

/** Why absolute paths: the serve host (and a service unit) runs from another working directory. */
export function readServeNetworkFlags(flags: Map<string, string | boolean>): ServeNetworkFlags {
  const bind = requiredValue(flags, 'bind')
  const allowIp = requiredValue(flags, 'allow-ip')
  const tlsCert = requiredValue(flags, 'tls-cert')
  const tlsKey = requiredValue(flags, 'tls-key')
  const tlsError = getServeTlsOptionValidationError({ tlsCert, tlsKey })
  if (tlsError) {
    throw new RuntimeClientError('invalid_argument', tlsError)
  }
  return {
    ...(bind ? { bind } : {}),
    ...(allowIp ? { allowIp } : {}),
    ...(tlsCert && tlsKey ? { tlsCert: resolve(tlsCert), tlsKey: resolve(tlsKey) } : {})
  }
}

export function serveNetworkArgs(flags: ServeNetworkFlags): string[] {
  return [
    ...(flags.bind ? ['--bind', flags.bind] : []),
    ...(flags.allowIp ? ['--allow-ip', flags.allowIp] : []),
    ...(flags.tlsCert ? ['--tls-cert', flags.tlsCert] : []),
    ...(flags.tlsKey ? ['--tls-key', flags.tlsKey] : [])
  ]
}

function requiredValue(flags: Map<string, string | boolean>, name: string): string | null {
  if (!flags.has(name)) {
    return null
  }
  const value = flags.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing value for --${name}.`)
  }
  return value
}
