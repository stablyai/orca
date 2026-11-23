// agy given a method with no credential falls back to its own saved Google login, which on macOS and
// Windows is shared by every home. So Orca's home takes a key or gcloud chat only when the
// credential is positively here; otherwise the chat runs on Orca's server, as before.

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readAntigravityChatApiKey } from './antigravity-chat-api-key-store'
import { envValue } from './antigravity-chat-credential'

const ADC_FILE = 'application_default_credentials.json'

export type AgyOrcaHomeCredentialProbe = {
  platform: NodeJS.Platform
  savedKey: () => Promise<string | null>
  isFile: (path: string) => Promise<boolean>
  /** Linux's DMI product name, which names Google on its Compute Engine machines. */
  productName: () => Promise<string>
}

const HOST_PROBE: AgyOrcaHomeCredentialProbe = {
  platform: process.platform,
  savedKey: readAntigravityChatApiKey,
  isFile: async (path) => (await stat(path).catch(() => null))?.isFile() === true,
  productName: () => readFile('/sys/class/dmi/id/product_name', 'utf8').catch(() => '')
}

/** Where Google's libraries find ADC without GOOGLE_APPLICATION_CREDENTIALS: gcloud's own folder
 *  under HOME (APPDATA on Windows), and CLOUDSDK_CONFIG's, which Orca names to the chat. */
function adcFiles(env: Readonly<Record<string, string>>, platform: NodeJS.Platform): string[] {
  const value = (name: string) => envValue(env, name, platform)
  const appData = value('APPDATA')
  const config = value('CLOUDSDK_CONFIG')
  const fallback =
    platform === 'win32' && appData
      ? join(appData, 'gcloud', ADC_FILE)
      : join(value('HOME') ?? value('USERPROFILE') ?? homedir(), '.config', 'gcloud', ADC_FILE)
  return [...(config ? [join(config, ADC_FILE)] : []), fallback]
}

/** Whether the saved method's credential is here: a key that decrypts or GEMINI_API_KEY, or an ADC
 *  file (or, on Linux only, which has no shared login to fall back to, a plausible GCE metadata
 *  server). A false answer only keeps the chat on Orca's server. */
export async function agyOrcaHomeCredentialPresent(
  method: 'gemini-api-key' | 'agent-platform',
  env: Readonly<Record<string, string>>,
  probe: AgyOrcaHomeCredentialProbe = HOST_PROBE
): Promise<boolean> {
  const value = (name: string) => envValue(env, name, probe.platform)
  if (method === 'gemini-api-key') {
    return Boolean(value('GEMINI_API_KEY')?.trim()) || Boolean(await probe.savedKey())
  }
  const named = value('GOOGLE_APPLICATION_CREDENTIALS')
  // Google's libraries read only the named file, and fail when it is missing.
  if (named) {
    return probe.isFile(named)
  }
  for (const file of adcFiles(env, probe.platform)) {
    if (await probe.isFile(file)) {
      return true
    }
  }
  return (
    probe.platform === 'linux' &&
    (Boolean(value('GCE_METADATA_HOST')) || (await probe.productName()).includes('Google'))
  )
}
