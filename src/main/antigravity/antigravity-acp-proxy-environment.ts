import { overlayEnvironmentVariables } from '../../shared/environment-overlay'
import { readMacosPythonProxyEnvironment } from '../network/macos-python-proxy-environment'

const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]']

/** Keep the managed Python server's private WebSocket direct without discarding external proxies. */
export async function prepareAntigravityAcpProxyEnvironment(
  env: Record<string, string>,
  inherited: NodeJS.ProcessEnv
): Promise<void> {
  const effective = overlayEnvironmentVariables(inherited, env, process.platform)
  const aliases = Object.entries(effective).filter(([key]) => key.toLowerCase() === 'no_proxy')
  const values = new Set(aliases.map(([, value]) => value ?? ''))
  const existingBypass = aliases[0]?.[1] ?? ''
  // Canonicalizing conflicting or Python-only exclusions changes the harness's external route.
  if (
    values.size > 1 ||
    (process.platform !== 'win32' &&
      existingBypass &&
      effective.NO_PROXY === undefined &&
      effective.no_proxy === undefined)
  ) {
    return
  }
  const proxies = pythonEnvironmentProxies(effective)
  const prepared = { ...env }
  let bypass: readonly string[] = []
  if (!proxies.size) {
    const system = await readMacosPythonProxyEnvironment()
    if (!system) {
      return
    }
    for (const [scheme, value] of Object.entries(system.proxies)) {
      prepared[`${scheme}_proxy`] = value
      // Retain an uppercase value that another consumer already selects.
      if (!effective[`${scheme.toUpperCase()}_PROXY`]) {
        prepared[`${scheme.toUpperCase()}_PROXY`] = value
      }
    }
    bypass = system.bypass
  } else if (![...proxies.keys()].some((scheme) => scheme !== 'no')) {
    return
  }
  const additions = [...bypass, ...LOOPBACK]
  for (const [key, value] of aliases) {
    prepared[key] = appendBypass(value ?? '', additions)
  }
  prepared.NO_PROXY = appendBypass(existingBypass, additions)
  prepared.no_proxy = appendBypass(existingBypass, additions)
  Object.assign(env, prepared)
}

function appendBypass(value: string, additions: readonly string[]): string {
  if (value === '*') {
    return value
  }
  const present = new Set(value.split(',').map((entry) => entry.trim().toLowerCase()))
  const missing = additions.filter((entry) => !present.has(entry.toLowerCase()))
  return [value, ...missing].filter(Boolean).join(',')
}

/** Python's lowercase pass can erase uppercase entries; even a no/unknown mapping blocks system fallback. */
function pythonEnvironmentProxies(env: NodeJS.ProcessEnv): Map<string, string> {
  const entries = Object.entries(env).filter(([key]) => key.toLowerCase().endsWith('_proxy'))
  const proxies = new Map<string, string>()
  for (const [key, value] of entries) {
    if (value) {
      proxies.set(key.slice(0, -6).toLowerCase(), value)
    }
  }
  if (env.REQUEST_METHOD !== undefined) {
    proxies.delete('http')
  }
  for (const [key, value] of entries) {
    if (!key.endsWith('_proxy')) {
      continue
    }
    const scheme = key.slice(0, -6).toLowerCase()
    if (value) {
      proxies.set(scheme, value)
    } else {
      proxies.delete(scheme)
    }
  }
  return proxies
}
