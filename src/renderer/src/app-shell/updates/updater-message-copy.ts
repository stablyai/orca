import { translate } from '@/i18n/i18n'
import type { LinuxPackageCommandUnavailableReason } from '../../../../shared/update-status-types'
import {
  UPDATER_FAILURE_COPY,
  type UpdaterFailureCode
} from '../../../../shared/updater-failure-copy'

type Param = (name: string) => string | null
type CountParam = (name: string) => number | null

// null = required params missing; caller shows the host's English message.
const COPY: Record<UpdaterFailureCode, (param: Param, count: CountParam) => string | null> = {
  releaseNotReady: () =>
    translate('updates.failure.releaseNotReady', UPDATER_FAILURE_COPY.releaseNotReady),
  updateServerUnreachable: () =>
    translate(
      'updates.failure.updateServerUnreachable',
      UPDATER_FAILURE_COPY.updateServerUnreachable
    ),
  channelUnsupportedPlatform: (param) => {
    const channel = param('channel')
    return channel === null
      ? null
      : translate(
          'updates.failure.channelUnsupportedPlatform',
          UPDATER_FAILURE_COPY.channelUnsupportedPlatform,
          {
            channel
          }
        )
  },
  unsignedDevChannel: (param) => {
    const channel = param('channel')
    return channel === null
      ? null
      : translate('updates.failure.unsignedDevChannel', UPDATER_FAILURE_COPY.unsignedDevChannel, {
          channel
        })
  },
  linuxPackageMissing: () =>
    translate('updates.failure.linuxPackageMissing', UPDATER_FAILURE_COPY.linuxPackageMissing),
  linuxPackageNotRegular: () =>
    translate(
      'updates.failure.linuxPackageNotRegular',
      UPDATER_FAILURE_COPY.linuxPackageNotRegular
    ),
  linuxPackageHashMismatch: () =>
    translate(
      'updates.failure.linuxPackageHashMismatch',
      UPDATER_FAILURE_COPY.linuxPackageHashMismatch
    ),
  linuxPackageReadFailed: () =>
    translate(
      'updates.failure.linuxPackageReadFailed',
      UPDATER_FAILURE_COPY.linuxPackageReadFailed
    ),
  linuxPackageNoSudo: () =>
    translate('updates.failure.linuxPackageNoSudo', UPDATER_FAILURE_COPY.linuxPackageNoSudo),
  linuxPackageNoPackageManager: () =>
    translate(
      'updates.failure.linuxPackageNoPackageManager',
      UPDATER_FAILURE_COPY.linuxPackageNoPackageManager
    ),
  linuxPackageInvalidPath: () =>
    translate(
      'updates.failure.linuxPackageInvalidPath',
      UPDATER_FAILURE_COPY.linuxPackageInvalidPath
    ),
  linuxPackageMarkerUnusable: () =>
    translate(
      'updates.failure.linuxPackageMarkerUnusable',
      UPDATER_FAILURE_COPY.linuxPackageMarkerUnusable
    ),
  linuxPackageExternallyManaged: () =>
    translate(
      'updates.failure.linuxPackageExternallyManaged',
      UPDATER_FAILURE_COPY.linuxPackageExternallyManaged
    ),
  linuxPackageManualInstall: () =>
    translate(
      'updates.failure.linuxPackageManualInstall',
      UPDATER_FAILURE_COPY.linuxPackageManualInstall
    ),
  linuxPackageMetadataUnusable: () =>
    translate(
      'updates.failure.linuxPackageMetadataUnusable',
      UPDATER_FAILURE_COPY.linuxPackageMetadataUnusable
    ),
  unknownReleaseChannel: (param) => {
    const channel = param('channel')
    return channel === null
      ? null
      : translate(
          'updates.failure.unknownReleaseChannel',
          UPDATER_FAILURE_COPY.unknownReleaseChannel,
          { channel }
        )
  },
  invalidReleaseTag: (param) => {
    const tag = param('tag')
    return tag === null
      ? null
      : translate('updates.failure.invalidReleaseTag', UPDATER_FAILURE_COPY.invalidReleaseTag, {
          tag
        })
  },
  releaseRepoNotFound: (param) => {
    const repo = param('repo')
    return repo === null
      ? null
      : translate('updates.failure.releaseRepoNotFound', UPDATER_FAILURE_COPY.releaseRepoNotFound, {
          repo
        })
  },
  releaseListFailed: (param, count) => {
    const channel = param('channel')
    const status = count('status')
    return channel === null || status === null
      ? null
      : translate('updates.failure.releaseListFailed', UPDATER_FAILURE_COPY.releaseListFailed, {
          channel,
          status
        })
  },
  releaseListUnreadable: (param) => {
    const channel = param('channel')
    return channel === null
      ? null
      : translate(
          'updates.failure.releaseListUnreadable',
          UPDATER_FAILURE_COPY.releaseListUnreadable,
          { channel }
        )
  },
  rateLimitedSoon: () =>
    translate('updates.failure.rateLimitedSoon', UPDATER_FAILURE_COPY.rateLimitedSoon),
  rateLimitedSoonSignedOut: () =>
    translate(
      'updates.failure.rateLimitedSoonSignedOut',
      UPDATER_FAILURE_COPY.rateLimitedSoonSignedOut
    ),
  rateLimitedInMinute: () =>
    translate('updates.failure.rateLimitedInMinute', UPDATER_FAILURE_COPY.rateLimitedInMinute),
  rateLimitedInMinuteSignedOut: () =>
    translate(
      'updates.failure.rateLimitedInMinuteSignedOut',
      UPDATER_FAILURE_COPY.rateLimitedInMinuteSignedOut
    ),
  rateLimitedInMinutes: (_param, count) => {
    const minutes = count('count')
    return minutes === null
      ? null
      : translate(
          'updates.failure.rateLimitedInMinutes',
          UPDATER_FAILURE_COPY.rateLimitedInMinutes,
          {
            count: minutes,
            defaultValue_one: 'GitHub rate limit reached. Try again in about {{count}} minute.'
          }
        )
  },
  rateLimitedInMinutesSignedOut: (_param, count) => {
    const minutes = count('count')
    return minutes === null
      ? null
      : translate(
          'updates.failure.rateLimitedInMinutesSignedOut',
          UPDATER_FAILURE_COPY.rateLimitedInMinutesSignedOut,
          {
            count: minutes,
            defaultValue_one:
              "GitHub rate limit reached. Try again in about {{count}} minute, or run `gh auth login` so Orca can use your account's higher limit."
          }
        )
  }
}

const COMMAND_UNAVAILABLE_CODES: Record<LinuxPackageCommandUnavailableReason, UpdaterFailureCode> =
  {
    'no-sudo': 'linuxPackageNoSudo',
    'no-package-manager': 'linuxPackageNoPackageManager'
  }

function isUpdaterFailureCode(code: unknown): code is UpdaterFailureCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

function codedText(code: unknown, params: unknown): string | null {
  if (!isUpdaterFailureCode(code)) {
    return null
  }
  const values: Record<string, unknown> =
    typeof params === 'object' && params !== null ? Object.fromEntries(Object.entries(params)) : {}
  return COPY[code](
    (name) => (typeof values[name] === 'string' ? values[name] : null),
    (name) => (typeof values[name] === 'number' ? values[name] : null)
  )
}

/** Updater message text: known codes translate; unknown codes and older hosts keep the English message. */
export function updaterMessageText(source: {
  message: string
  messageCode?: unknown
  messageParams?: unknown
}): string {
  return codedText(source.messageCode, source.messageParams) ?? source.message
}

/** The install-instructions result already names its reason; unknown reasons keep main's English. */
export function linuxPackageCommandUnavailableText(instructions: {
  reason: LinuxPackageCommandUnavailableReason
  message: string
}): string {
  return (
    codedText(
      Object.hasOwn(COMMAND_UNAVAILABLE_CODES, instructions.reason)
        ? COMMAND_UNAVAILABLE_CODES[instructions.reason]
        : undefined,
      undefined
    ) ?? instructions.message
  )
}
