import os from 'node:os'
import path from 'node:path'
import type { ServeManualUpdateMethod } from '../shared/remote-server-update'
import {
  buildLinuxPackageInstallCommand,
  quoteForPosixShell,
  resolveTrustedExecutable
} from './linux-package-install-command'

export const SERVE_UPGRADE_DOC_URL =
  'https://github.com/stablyai/orca/blob/main/docs/reference/headless-linux-server.md#upgrade'
// Why: that guide is systemd-specific, but a Windows or macOS serve host resolves to the same
// install mode — it must not be handed systemd vocabulary or a Linux-only link.
const SERVE_REMOTE_DOC_URL = 'https://www.onorca.dev/docs/remote-servers'

export function getServeUpgradeDocUrl(platform: NodeJS.Platform = process.platform): string {
  return platform === 'linux' ? SERVE_UPGRADE_DOC_URL : SERVE_REMOTE_DOC_URL
}

// Why: no unit/service name is knowable from inside the runtime, and #14068 forbids guessing one.
// Only the vocabulary for "the thing that supervises this process" varies by platform.
function restartStep(platform: NodeJS.Platform): string {
  const supervisor =
    platform === 'linux'
      ? 'service unit'
      : platform === 'win32'
        ? 'Windows service or scheduled task'
        : 'launchd job or supervisor'
  return `Restart the ${supervisor} that runs \`orca serve\`. Orca does not restart itself: nothing here can prove exactly one replacement would start.`
}

function documentedProcedureStep(documentationUrl: string): string {
  return `Follow the documented upgrade procedure for this install: ${documentationUrl}`
}

/** Rejects anything a release tag should never contain before it reaches a shell-quoted path. */
function sanitizeVersionForFileName(version: string): string | null {
  return /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version) ? version : null
}

function buildPackageSteps(
  method: 'deb' | 'rpm',
  latestVersion: string,
  releaseUrl: string,
  documentationUrl: string,
  restart: string
): string[] {
  const safeVersion = sanitizeVersionForFileName(latestVersion)
  if (!safeVersion) {
    return [documentedProcedureStep(documentationUrl), restart]
  }
  // posix.join: this advice only ever describes a Linux host.
  const stagedPath = path.posix.join(os.tmpdir(), `orca-${safeVersion}.${method}`)
  const install = buildLinuxPackageInstallCommand(method, stagedPath)
  if (!install.ok) {
    return [documentedProcedureStep(documentationUrl), restart]
  }
  return [
    `Download the .${method} for this machine's architecture from ${releaseUrl} to ${stagedPath}`,
    install.command,
    restart
  ]
}

function buildAppImageSteps(
  appImagePath: string,
  releaseUrl: string,
  documentationUrl: string,
  restart: string
): string[] {
  const sudoPath = resolveTrustedExecutable('sudo')
  const movePath = resolveTrustedExecutable('mv')
  if (!sudoPath || !movePath) {
    return [documentedProcedureStep(documentationUrl), restart]
  }
  const stagedPath = `${appImagePath}.new`
  return [
    // Why: the running AppImage is FUSE-mounted, so it must never be written in place.
    `Download the Linux AppImage for this machine's architecture from ${releaseUrl} to ${stagedPath}`,
    `${sudoPath} ${movePath} -- ${quoteForPosixShell(stagedPath)} ${quoteForPosixShell(appImagePath)}`,
    restart
  ]
}

/**
 * The exact operator steps for a host Orca refuses to update itself. Every command is a fixed
 * literal plus POSIX-single-quoted paths, and none of them is ever executed — the serve process
 * runs unprivileged with no authentication agent, so the privileged install stays the operator's
 * action by design.
 */
export function buildServeManualUpdateSteps(input: {
  method: ServeManualUpdateMethod
  latestVersion: string
  releaseUrl: string
  /** Absolute path of the running AppImage, when the method is `appimage`. */
  appImagePath: string | null
  platform?: NodeJS.Platform
  documentationUrl?: string
}): string[] {
  const platform = input.platform ?? process.platform
  const documentationUrl = input.documentationUrl ?? getServeUpgradeDocUrl(platform)
  const restart = restartStep(platform)
  if (input.method === 'deb' || input.method === 'rpm') {
    return buildPackageSteps(
      input.method,
      input.latestVersion,
      input.releaseUrl,
      documentationUrl,
      restart
    )
  }
  if (input.method === 'appimage' && input.appImagePath && path.isAbsolute(input.appImagePath)) {
    return buildAppImageSteps(input.appImagePath, input.releaseUrl, documentationUrl, restart)
  }
  if (input.method === 'externally-managed') {
    // Why: a GitHub download is useless here — no package manager on this host could apply it.
    // The distribution or repackager that installed Orca owns the upgrade.
    return [
      `Orca ${input.latestVersion} is published, but this install came from a repackager or distribution rather than an Orca release artifact.`,
      'Update through whichever package manager installed Orca; a package downloaded from the Orca release page cannot be applied on this host.',
      restart
    ]
  }
  return [
    `Download the release for this machine's architecture from ${input.releaseUrl}`,
    documentedProcedureStep(documentationUrl),
    restart
  ]
}
