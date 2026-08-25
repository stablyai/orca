import { homedir } from 'node:os'
import { join } from 'node:path'

export function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

export function getInstanceFilePath(): string {
  return join(getOrcaDir(), 'plane-instances.json')
}

export function getInstanceTokenDir(): string {
  return join(getOrcaDir(), 'plane-tokens')
}

export function getInstanceTokenPath(instanceId: string): string {
  return join(getInstanceTokenDir(), `${Buffer.from(instanceId).toString('base64url')}.enc`)
}
