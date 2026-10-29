import { setFilesystemHostReadClientForTests } from '../src/main/filesystem-host/filesystem-host-read-authority'

// Why plain realpath, not realpath.native: this must mirror filesystem-host-operation.ts, or
// every consumer test silently runs different canonicalization semantics than the real child.
setFilesystemHostReadClientForTests({
  isSymlink: async (path) =>
    (await (await import('node:fs/promises')).lstat(path)).isSymbolicLink(),
  prepareKeybindings: async (
    path,
    platform,
    legacyOverrides,
    seedLegacyTabSwitchBindings,
    change
  ) => {
    const { executeFilesystemHostOperation } =
      await import('../src/main/filesystem-host/filesystem-host-operation')
    const result = executeFilesystemHostOperation({
      kind: 'prepare-keybindings',
      path,
      platform: platform === 'darwin' || platform === 'win32' ? platform : 'linux',
      legacyOverrides: legacyOverrides as Record<string, string[]> | undefined,
      seedLegacyTabSwitchBindings,
      ...change
    })
    if (result.kind !== 'prepare-keybindings') {
      throw new Error('Unexpected result')
    }
    return result
  },
  canonicalizePath: async (path) => (await import('node:fs/promises')).realpath(path),
  readOrcaYaml: async (path) => (await import('node:fs/promises')).readFile(path, 'utf8'),
  readKeybindings: async (path) => (await import('node:fs/promises')).readFile(path, 'utf8'),
  readSnapshotFile: async (path) => (await import('node:fs/promises')).readFile(path),
  prepareRateLimitPtyCwd: async (path) => {
    const fs = await import('node:fs')
    fs.mkdirSync(path, { recursive: true })
    return fs.realpathSync(path)
  },
  resolveCliCommand: async (commandName) => {
    const { resolveCliCommand } = await import('../src/shared/node-cli-command-resolution')
    return resolveCliCommand(commandName)
  },
  writeRateLimitCredential: async (path, _fileKind, contents) => {
    const { writeCredentialFileAtomic } = await import('../src/main/integration-credential-file')
    writeCredentialFileAtomic(path, Buffer.from(contents, 'utf8'))
  }
})
