// Build-time constants, substituted by config/scripts/build-mobile-web-bundle.mjs via esbuild define.
declare const ORCA_MOBILE_WEB_DESKTOP_VERSION: string
declare const ORCA_MOBILE_WEB_RUNTIME_PROTOCOL_VERSION: number
declare const ORCA_MOBILE_WEB_MIN_COMPATIBLE_RUNTIME_PROTOCOL_VERSION: number

// Why a runtime read and not a define: buildId is the hash of the asset list that index.html
// belongs to, so injecting it into a hashed asset would make the hash depend on itself.
const MANIFEST_URL = './manifest.json'

function isBuildId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

async function readBuildId(): Promise<string> {
  const response = await fetch(MANIFEST_URL, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`manifest request failed with ${String(response.status)}`)
  }
  const manifest: unknown = await response.json()
  // `in` narrows without an assertion; the manifest is untrusted JSON either way.
  if (typeof manifest !== 'object' || manifest === null || !('buildId' in manifest)) {
    throw new Error('manifest has no buildId')
  }
  const { buildId } = manifest
  if (!isBuildId(buildId)) {
    throw new Error('manifest buildId is not a sha256 digest')
  }
  return buildId
}

function renderFacts(facts: readonly (readonly [string, string])[]): void {
  const list = document.getElementById('bootstrap-facts')
  if (!(list instanceof HTMLDListElement)) {
    return
  }
  list.replaceChildren()
  for (const [term, description] of facts) {
    const dt = document.createElement('dt')
    dt.textContent = term
    const dd = document.createElement('dd')
    dd.textContent = description
    dd.dataset.fact = term
    list.append(dt, dd)
  }
}

async function start(): Promise<void> {
  let buildId: string
  try {
    buildId = await readBuildId()
  } catch (error) {
    buildId = `unavailable (${error instanceof Error ? error.message : String(error)})`
  }
  renderFacts([
    ['buildId', buildId],
    ['desktopVersion', ORCA_MOBILE_WEB_DESKTOP_VERSION],
    ['runtimeProtocolVersion', String(ORCA_MOBILE_WEB_RUNTIME_PROTOCOL_VERSION)],
    [
      'minCompatibleRuntimeProtocolVersion',
      String(ORCA_MOBILE_WEB_MIN_COMPATIBLE_RUNTIME_PROTOCOL_VERSION)
    ]
  ])
}

void start()
