import { join, posix } from 'node:path'
import type { SkillPackageManifestV1 } from '../../shared/skill-package-manifest'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  SKILL_PACKAGE_OBSERVATION_LIMITS,
  observeSkillPackage,
  type ObservedSkillPackage
} from './skill-package-identity'
import type { SkillInstallFilesystem, SkillInstalledFileMode } from './skill-install-filesystem'
import { SKILL_INSTALL_PROVIDERS } from '../../shared/skill-install-providers'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'
import { runWslProcess } from '../wsl/wsl-runner'

const BATCH_FILE_COUNT = 8
const GUEST_COMMAND_TIMEOUT_MS = 30_000
const GUEST_COMMAND_MAX_OUTPUT_BYTES = 64 * 1024

function isWindowsBackedGuestPath(path: string): boolean {
  return /^\/mnt\/[a-z](?:\/|$)/iu.test(path)
}

const APPLY_MODES_SCRIPT = [
  'set -eu',
  'while [ "$#" -gt 1 ]; do',
  '  mode=$1; file=$2; shift 2',
  '  chmod "$mode" -- "$file"',
  'done'
].join('\n')

const VERIFY_MODES_SCRIPT = [
  'set -eu',
  'while [ "$#" -gt 1 ]; do',
  '  expected=$1; file=$2; shift 2',
  '  actual=$(stat -c %a -- "$file")',
  '  [ "$actual" = "$expected" ] || exit 42',
  'done'
].join('\n')

const RENAME_SCRIPT = [
  'set -eu',
  '[ ! -e "$2" ] && [ ! -L "$2" ] || exit 43',
  'mv -- "$1" "$2"',
  'sync -f "$2" 2>/dev/null || sync'
].join('\n')

const REMOVE_SCRIPT = [
  'set -eu',
  'parent=$(dirname -- "$1")',
  'rm -rf -- "$1"',
  'sync -f "$parent" 2>/dev/null || sync'
].join('\n')

const CREATE_ALIAS_SCRIPT = [
  'set -eu',
  'parent=$(dirname -- "$2")',
  'mkdir -p -- "$parent"',
  'chmod 700 -- "$parent"',
  'ln -sT -- "$1" "$2"',
  'sync -f "$parent" 2>/dev/null || sync'
].join('\n')

const ALIAS_TARGET_SCRIPT = [
  'set -eu',
  '[ -L "$2" ] || exit 0',
  '[ "$(readlink -f -- "$1")" = "$(readlink -f -- "$2")" ] && printf yes'
].join('\n')

export class WslSkillInstallFilesystem implements SkillInstallFilesystem {
  private readonly guestAllowedRoots: string[]

  constructor(
    private readonly distro: string,
    allowedRoots: readonly string[]
  ) {
    this.guestAllowedRoots = allowedRoots.map((path) => this.toGuestPath(path))
  }

  authorizeRoots(paths: readonly string[]): void {
    for (const path of paths) {
      const guestRoot = this.toGuestPath(path)
      if (!this.guestAllowedRoots.includes(guestRoot)) {
        this.guestAllowedRoots.push(guestRoot)
      }
    }
  }

  async prepareExtractedSkill(path: string, manifest: SkillPackageManifestV1): Promise<void> {
    const guestRoot = this.requireAllowed(path)
    if (isWindowsBackedGuestPath(guestRoot)) {
      return
    }
    const directories = new Set([guestRoot])
    for (const file of manifest.files) {
      let directory = posix.dirname(posix.join(guestRoot, file.path))
      while (directory !== guestRoot && directory.startsWith(`${guestRoot}/`)) {
        directories.add(directory)
        directory = posix.dirname(directory)
      }
    }
    await this.applyModes([
      ...[...directories].map((directory) => ({ path: directory, mode: '700' })),
      ...manifest.files.map((file) => ({
        path: posix.join(guestRoot, file.path),
        mode: file.executable ? '700' : '600'
      }))
    ])
    await this.verifyModes(guestRoot, manifest.files)
  }

  async observeSkill(
    path: string,
    files?: readonly SkillInstalledFileMode[]
  ): Promise<ObservedSkillPackage> {
    if (!files) {
      return observeSkillPackage(path)
    }
    const guestRoot = this.requireAllowed(path)
    if (!isWindowsBackedGuestPath(guestRoot)) {
      await this.verifyModes(guestRoot, files)
    }
    return observeSkillPackage(
      path,
      SKILL_PACKAGE_OBSERVATION_LIMITS,
      new Set(files.filter((file) => file.executable).map((file) => file.path))
    )
  }

  async rename(source: string, target: string): Promise<void> {
    await this.run(RENAME_SCRIPT, [this.requireAllowed(source), this.requireAllowed(target)])
  }

  async remove(path: string): Promise<void> {
    await this.run(REMOVE_SCRIPT, [this.requireAllowed(path)])
  }

  async createAlias(canonicalPath: string, destinationPath: string): Promise<void> {
    await this.run(CREATE_ALIAS_SCRIPT, [
      this.requireAllowed(canonicalPath),
      this.requireAllowed(destinationPath)
    ])
  }

  async aliasTargets(canonicalPath: string, destinationPath: string): Promise<boolean> {
    return (
      (await this.runOutput(ALIAS_TARGET_SCRIPT, [
        this.requireAllowed(canonicalPath),
        this.requireAllowed(destinationPath)
      ])) === 'yes'
    )
  }

  private async applyModes(entries: { path: string; mode: string }[]): Promise<void> {
    for (let offset = 0; offset < entries.length; offset += BATCH_FILE_COUNT) {
      await this.run(
        APPLY_MODES_SCRIPT,
        entries
          .slice(offset, offset + BATCH_FILE_COUNT)
          .flatMap((entry) => [entry.mode, entry.path])
      )
    }
  }

  private async verifyModes(root: string, files: readonly SkillInstalledFileMode[]): Promise<void> {
    const entries = files.map((file) => ({
      path: posix.join(root, file.path),
      mode: file.executable ? '700' : '600'
    }))
    for (let offset = 0; offset < entries.length; offset += BATCH_FILE_COUNT) {
      await this.run(
        VERIFY_MODES_SCRIPT,
        entries
          .slice(offset, offset + BATCH_FILE_COUNT)
          .flatMap((entry) => [entry.mode, entry.path])
      )
    }
  }

  private toGuestPath(path: string): string {
    const parsed = parseWslUncPath(path)
    if (parsed) {
      if (
        parsed.distro.toLocaleLowerCase('en-US') !== this.distro.toLocaleLowerCase('en-US') ||
        !posix.isAbsolute(parsed.linuxPath) ||
        parsed.linuxPath.includes('\0')
      ) {
        throw new Error('skill-install-wsl-path-invalid')
      }
      return posix.normalize(parsed.linuxPath)
    }
    const drive = path.replace(/\\/g, '/').match(/^([A-Za-z]):\/(.*)$/)
    if (!drive || path.includes('\0')) {
      throw new Error('skill-install-wsl-path-invalid')
    }
    return posix.join('/mnt', drive[1].toLocaleLowerCase('en-US'), drive[2])
  }

  private requireAllowed(path: string): string {
    const guestPath = this.toGuestPath(path)
    const allowed = this.guestAllowedRoots.some((root) => {
      const child = posix.relative(root, guestPath)
      return child !== '' && child !== '..' && !child.startsWith('../') && !posix.isAbsolute(child)
    })
    if (!allowed) {
      throw new Error('skill-install-wsl-path-outside-root')
    }
    return guestPath
  }

  private async run(script: string, args: string[]): Promise<void> {
    await this.runOutput(script, args)
  }

  private async runOutput(script: string, args: string[]): Promise<string> {
    const result = await runWslProcess({
      distro: this.distro,
      loginPath: 'none',
      script,
      // POSIX file operations; declared because the payload is opaque here.
      shell: 'sh',
      args,
      timeoutMs: GUEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: GUEST_COMMAND_MAX_OUTPUT_BYTES
    })
    if (result.code !== 0 || result.timedOut) {
      throw Object.assign(new Error('skill-install-wsl-guest-operation-failed'), {
        cause: new Error(`wsl exited ${result.code}: ${result.stderr}`)
      })
    }
    return result.stdout.trim()
  }
}

export function createWslSkillInstallFilesystem(input: {
  distro: string
  homeDirectory: string
  workspaceDirectory?: string
  providerRootOverrides?: SkillProviderRootOverrides
}): WslSkillInstallFilesystem {
  const scopeRoot = input.workspaceDirectory ?? input.homeDirectory
  const scope = input.workspaceDirectory ? 'workspace' : 'global'
  const providerRoots = SKILL_INSTALL_PROVIDERS.flatMap((provider) => {
    const segments = scope === 'global' ? provider.globalSegments : provider.workspaceSegments
    const overriddenRoot =
      scope === 'global' ? input.providerRootOverrides?.[provider.id] : undefined
    return overriddenRoot ? [overriddenRoot] : segments ? [join(scopeRoot, ...segments)] : []
  })
  return new WslSkillInstallFilesystem(input.distro, [
    join(scopeRoot, '.agents', 'skills'),
    ...providerRoots
  ])
}
