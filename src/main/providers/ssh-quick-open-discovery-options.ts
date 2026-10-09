import type { IFilesystemProvider } from './types'

export async function resolveSshQuickOpenDiscoveryOptions(
  provider: IFilesystemProvider,
  options: {
    includeIgnored?: boolean
    followSymlinks?: boolean
    allowLegacyIncludeIgnored?: boolean
  },
  signal?: AbortSignal
): Promise<{ includeIgnored?: boolean; followSymlinks?: boolean }> {
  const supported =
    (options.includeIgnored !== false && !options.followSymlinks) ||
    (await provider.supportsQuickOpenSearch?.({ signal, minimumVersion: 2 }))
  if (!supported && (options.followSymlinks || !options.allowLegacyIncludeIgnored)) {
    throw new Error('Update the remote host to use Quick Open listing options.')
  }
  return {
    ...(options.includeIgnored === undefined || !supported
      ? {}
      : { includeIgnored: options.includeIgnored }),
    ...(options.followSymlinks === undefined ? {} : { followSymlinks: options.followSymlinks })
  }
}
