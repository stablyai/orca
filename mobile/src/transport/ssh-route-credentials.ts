import { SshRouteCredentialsSchema, type SshRouteCredentials } from './ssh-route-auth'
import {
  deletePairingKeychainItem,
  readPairingKeychainItem,
  writePairingKeychainItem
} from './pairing-keychain'

const CHUNK_SIZE = 1500
const MAX_CHUNKS = 256

function key(id: string): string {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) {
    throw new Error('Invalid SSH credential reference')
  }
  return `orca.ssh.${id}`
}

async function chunkCount(id: string): Promise<number> {
  const raw = await readPairingKeychainItem(key(id))
  if (raw === null) {
    return 0
  }
  const count = Number(raw)
  if (!Number.isInteger(count) || count < 1 || count > MAX_CHUNKS) {
    throw new Error('SSH credential storage is unreadable')
  }
  return count
}

// IDs are immutable: publish the route only after every secure chunk has been written.
export async function writeSshRouteCredentials(
  id: string,
  credentials: SshRouteCredentials
): Promise<void> {
  const encoded = encodeURIComponent(JSON.stringify(SshRouteCredentialsSchema.parse(credentials)))
  const count = Math.ceil(encoded.length / CHUNK_SIZE)
  if (count > MAX_CHUNKS) {
    throw new Error('SSH credential is too large')
  }
  await writePairingKeychainItem(key(id), String(count))
  try {
    for (let i = 0; i < count; i++) {
      await writePairingKeychainItem(
        `${key(id)}.${i}`,
        encoded.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
      )
    }
  } catch (error) {
    await deleteSshRouteCredentials(id).catch(() => {})
    throw error
  }
}

export async function readSshRouteCredentials(id: string): Promise<SshRouteCredentials> {
  const count = await chunkCount(id)
  if (!count) {
    throw new Error('SSH credentials are missing. Edit the SSH connection to save them again.')
  }
  let encoded = ''
  for (let i = 0; i < count; i++) {
    const chunk = await readPairingKeychainItem(`${key(id)}.${i}`)
    if (chunk === null) {
      throw new Error('SSH credentials are incomplete. Save them again.')
    }
    encoded += chunk
  }
  return SshRouteCredentialsSchema.parse(JSON.parse(decodeURIComponent(encoded)))
}

export async function deleteSshRouteCredentials(id: string): Promise<void> {
  const count = await chunkCount(id)
  for (let i = 0; i < count; i++) {
    await deletePairingKeychainItem(`${key(id)}.${i}`)
  }
  await deletePairingKeychainItem(key(id))
}
