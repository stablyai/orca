import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  credentialFileHasContent,
  readStoredCredentialToken,
  writeCredentialFileAtomic,
  writeEncryptedCredential
} from '../integration-credential-file'
import { normalizeKaneoSiteUrl } from '../../shared/kaneo-task-url'
import type { KaneoConnectArgs, KaneoConnectionStatus } from '../../shared/kaneo-types'

function paths() {
  const dir = join(homedir(), '.orca')
  return { dir, metadata: join(dir, 'kaneo.json'), secret: join(dir, 'kaneo.enc') }
}

export function getKaneoStatus(): KaneoConnectionStatus {
  const files = paths()
  if (!credentialFileHasContent(files.secret)) {
    return { connected: false, siteUrl: null }
  }
  try {
    const metadata = JSON.parse(readFileSync(files.metadata, 'utf8'))
    const siteUrl = normalizeKaneoSiteUrl(metadata.siteUrl)
    return { connected: true, siteUrl }
  } catch {
    return { connected: false, siteUrl: null }
  }
}

export function readKaneoCredential(): KaneoConnectArgs | null {
  const file = paths().secret
  if (!existsSync(file)) {
    return null
  }
  const raw = readStoredCredentialToken('Kaneo', readFileSync(file))
  if (!raw) {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(
      'Saved Kaneo credentials are invalid. Reconnect Kaneo in Settings → Integrations.'
    )
  }
  if (!value || typeof value !== 'object') {
    return null
  }
  const stored = value as Partial<KaneoConnectArgs>
  if (
    typeof stored.apiKey !== 'string' ||
    !stored.apiKey.trim() ||
    typeof stored.siteUrl !== 'string'
  ) {
    return null
  }
  return { siteUrl: normalizeKaneoSiteUrl(stored.siteUrl), apiKey: stored.apiKey }
}

export function saveKaneoCredential(credential: KaneoConnectArgs): void {
  const files = paths()
  mkdirSync(files.dir, { recursive: true, mode: 0o700 })
  // The encrypted envelope binds the key to its origin even if metadata writes fail.
  writeEncryptedCredential('Kaneo', files.secret, JSON.stringify(credential))
  writeCredentialFileAtomic(
    files.metadata,
    Buffer.from(JSON.stringify({ siteUrl: credential.siteUrl }))
  )
}

export function disconnectKaneo(): void {
  const files = paths()
  for (const file of [files.secret, files.metadata]) {
    if (existsSync(file)) {
      unlinkSync(file)
    }
  }
}
