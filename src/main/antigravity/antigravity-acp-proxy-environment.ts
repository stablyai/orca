import { overlayEnvironmentVariables } from '../../shared/environment-overlay'
import { readMacosPythonProxyEnvironment } from '../network/macos-python-proxy-environment'

const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]']

/** Keep the managed Python server's private WebSocket direct without discarding external proxies. */
export async function prepareAntigravityAcpProxyEnvironment(
  env: Record<string, string>,
  inherited: NodeJS.ProcessEnv
): Promise<void> {
  const effective = overlayEnvironmentVariables(inherited, env, process.platform)
  const proxies = pythonEnvironmentProxies(effective)
  let bypass: readonly string[] = []
  if (!proxies.size) {
    const system = await readMacosPythonProxyEnvironment()
    if (!system) {
      return
    }
    for (const [scheme, value] of Object.entries(system.proxies)) {
      env[`${scheme}_proxy`] = value
      // Retain an uppercase value that another consumer already selects.
      if (!effective[`${scheme.toUpperCase()}_PROXY`]) {
        env[`${scheme.toUpperCase()}_PROXY`] = value
      }
    }
    bypass = system.bypass
  } else if (![...proxies.keys()].some((scheme) => scheme !== 'no')) {
    return
  }
  const selectedWindowsBypass =
    process.platform === 'win32'
      ? Object.keys(effective)
          .sort()
          .find((key) => key.toUpperCase() === 'NO_PROXY')
      : undefined
  const upper = selectedWindowsBypass ? effective[selectedWindowsBypass] : effective.NO_PROXY
  const lower = selectedWindowsBypass ? effective[selectedWindowsBypass] : effective.no_proxy
  env.NO_PROXY = appendBypass(upper ?? lower ?? '', [...bypass, ...LOOPBACK])
  env.no_proxy = appendBypass(lower ?? upper ?? '', [...bypass, ...LOOPBACK])
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
