import type {
  FilesystemCliCommandName,
  RateLimitCredentialFileKind
} from '../../shared/filesystem-host-protocol'
import {
  FilesystemHostReadError,
  requireFilesystemHostReadClient
} from './filesystem-host-read-authority'

export async function resolveCliCommandThroughFilesystemHost(
  commandName: FilesystemCliCommandName
): Promise<string> {
  try {
    const client = requireFilesystemHostReadClient()
    return client.resolveCliCommand ? await client.resolveCliCommand(commandName) : commandName
  } catch {
    return commandName
  }
}

export async function writeRateLimitCredentialThroughFilesystemHost(
  path: string,
  fileKind: RateLimitCredentialFileKind,
  contents: string
): Promise<void> {
  const client = requireFilesystemHostReadClient()
  if (!client.writeRateLimitCredential) {
    throw new FilesystemHostReadError('unavailable')
  }
  await client.writeRateLimitCredential(path, fileKind, contents)
}
