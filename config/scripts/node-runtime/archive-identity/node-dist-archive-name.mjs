// Kept apart from update-node-runtime-pin.mjs so the offline check does not load its build graph.

/** Node's platform suffix for each server target; nodejs.org names Windows `win`, not `win32`. */
export const NODE_DIST_PLATFORMS = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-arm64-glibc': 'linux-arm64',
  'linux-x64-glibc': 'linux-x64',
  'linux-arm64-musl': 'linux-arm64-musl',
  'linux-x64-musl': 'linux-x64-musl',
  'win32-arm64': 'win-arm64',
  'win32-x64': 'win-x64',
  'linux-x64-glibc217': 'linux-x64-glibc-217'
}

export function nodeDistArchiveName(version, target) {
  // Why .tar.gz over .tar.xz: every POSIX host can extract gzip; xz is not guaranteed.
  const extension = target.startsWith('win32-') ? 'zip' : 'tar.gz'
  return `node-v${version}-${NODE_DIST_PLATFORMS[target]}.${extension}`
}

export function windowsImportLibFile(target) {
  return `${NODE_DIST_PLATFORMS[target]}/node.lib`
}
