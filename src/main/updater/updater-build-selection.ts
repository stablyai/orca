import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import {
  DEV_CHANNEL_PLATFORM_LABEL,
  getVersionChannel,
  hasDedicatedReleaseRepo,
  isChannelSupportedOnPlatform,
  RELEASE_CHANNEL_LABELS,
  requiresManualDevChannelInstall,
  type ReleaseBuild,
  type ReleaseChannel
} from '../../shared/release-channel'
import { compareVersions } from '../updater-fallback'
import { listReleaseBuilds, resolveTargetBuild } from '../updater-release-builds'
import { UpdaterMenuChecks } from './updater-menu-checks'

/** Handles local-build selection and exact release-channel/tag jumps. */
export abstract class UpdaterBuildSelection extends UpdaterMenuChecks {
  protected async checkForLocalBuildFromMenu(): Promise<void> {
    if (process.platform !== 'darwin') {
      this.sendLocalBuildErrorAndRestore(
        'Local build switching is currently available only on macOS.',
        true
      )
      return
    }
    if (this.currentStatus.state === 'checking' || this.currentStatus.state === 'downloading') {
      return
    }
    if (this.localBuildSelectionInProgress) {
      return
    }
    this.localBuildSelectionInProgress = true
    try {
      const [{ chooseLocalBuild }, { startLocalBuildFeed }] = await Promise.all([
        import('../local-builds/local-build-switch'),
        import('../local-builds/local-build-feed-server')
      ])
      const candidate = await chooseLocalBuild(this.mainWindowRef)
      if (!candidate) {
        return
      }
      this.closeLocalBuildFeed()
      const feed = await startLocalBuildFeed(candidate)
      this.activeLocalBuildFeed = feed
      this.activeUpdateSource = 'local'
      this.clearPrereleaseFallbackContext()
      this.clearPublishingWindowLastGoodCheck()
      this.clearAvailableUpdateContext()
      this.activeUpdateNudgeId = null
      this.userInitiatedCheck = true
      this.sendStatus({ state: 'checking', userInitiated: true })

      const updater = this.getAutoUpdater()
      updater.allowDowngrade = true
      updater.disableDifferentialDownload = true
      updater.setFeedURL({ provider: 'generic', url: feed.url })
      const attemptId = this.beginUpdateCheckAttempt()
      this.markUpdateCheckLaunched(attemptId)
      await updater.checkForUpdates()
      this.handleSettledUpdateCheckPromise(attemptId)
    } catch (error) {
      this.userInitiatedCheck = false
      this.sendLocalBuildErrorAndRestore(String((error as Error)?.message ?? error), true)
    } finally {
      this.localBuildSelectionInProgress = false
    }
  }

  protected async listAvailableReleaseBuilds(channel: ReleaseChannel): Promise<ReleaseBuild[]> {
    return listReleaseBuilds(channel)
  }

  /** Pins the updater at one exact release tag and checks it, so a dev can move to any published build on any channel — including an older one. */
  protected async checkForPinnedBuild(channel: ReleaseChannel, tag: string): Promise<void> {
    if (!app.isPackaged || is.dev) {
      this.sendStatus({ state: 'not-available', userInitiated: true })
      return
    }
    // Why here as well as in the picker: the renderer disables the option, but IPC is reachable regardless, and there is no artifact to install on a platform the dev workflows do not build for.
    if (!isChannelSupportedOnPlatform(channel, process.platform)) {
      this.sendStatus({
        state: 'error',
        message: `${RELEASE_CHANNEL_LABELS[channel]} builds are produced only for ${DEV_CHANNEL_PLATFORM_LABEL}.`,
        userInitiated: true
      })
      return
    }
    // Why: electron-updater would otherwise take this all the way to a download and fail it with a raw ERR_UPDATER_INVALID_SIGNATURE. Say what to do instead — the installer is run by hand once, and in-app updates work from there on.
    if (
      requiresManualDevChannelInstall({
        platform: process.platform,
        runningChannel: getVersionChannel(app.getVersion()),
        targetChannel: channel
      })
    ) {
      this.sendStatus({
        state: 'error',
        message: `${RELEASE_CHANNEL_LABELS[channel]} builds are unsigned, and this signed build only installs updates signed by Orca's publisher. Download the installer from the release page and run it once — updates work normally from there, including back to Stable.`,
        userInitiated: true
      })
      return
    }
    if (this.currentStatus.state === 'checking' || this.currentStatus.state === 'downloading') {
      return
    }
    if (this.localBuildSelectionInProgress || this.pinnedBuildSelectionInProgress) {
      return
    }
    this.pinnedBuildSelectionInProgress = true
    try {
      const target = resolveTargetBuild(channel, tag)
      if (compareVersions(target.version, app.getVersion()) === 0) {
        this.sendSettledCheckStatus({ state: 'not-available', userInitiated: true })
        return
      }
      this.closeLocalBuildFeed()
      this.activeUpdateSource = hasDedicatedReleaseRepo(channel) ? channel : 'release'
      this.isPinnedBuildActive = true
      this.clearPrereleaseFallbackContext()
      this.clearPublishingWindowLastGoodCheck()
      this.clearAvailableUpdateContext()
      this.activeUpdateNudgeId = null
      this.userInitiatedCheck = true
      this.sendStatus({ state: 'checking', userInitiated: true })

      const updater = this.getAutoUpdater()
      // Why: an intentional jump to an older tag must not be filtered out as "not newer".
      updater.allowDowngrade = true
      updater.disableDifferentialDownload = true
      updater.allowPrerelease = true
      console.info(`[updater] pinned to ${channel} build ${target.tag} → ${target.feedUrl}`)
      updater.setFeedURL({ provider: 'generic', url: target.feedUrl })
      this.availableReleaseUrl = target.feedUrl
      const attemptId = this.beginUpdateCheckAttempt()
      this.markUpdateCheckLaunched(attemptId)
      await updater.checkForUpdates()
      this.handleSettledUpdateCheckPromise(attemptId)
    } catch (error) {
      this.userInitiatedCheck = false
      this.clearAvailableUpdateContext()
      this.restoreReleaseUpdateSource()
      this.sendSettledCheckStatus({
        state: 'error',
        message: String((error as Error)?.message ?? error),
        userInitiated: true
      })
    } finally {
      this.pinnedBuildSelectionInProgress = false
    }
  }
}
