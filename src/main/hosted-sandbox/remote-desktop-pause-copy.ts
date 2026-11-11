// What a remote desktop page says when main stops handing it tickets (remote-desktop-guest.ts).
import { translateMain } from '../i18n/main-i18n'
import type { RemoteDesktopPauseReason } from '../../shared/hosted-sandbox/cloud-remote-desktop'

export function remoteDesktopPauseMessage(reason: RemoteDesktopPauseReason): string {
  switch (reason) {
    case 'asleep':
      return translateMain(
        'components.cloudRemoteDesktop.pageAsleep',
        'This workspace is asleep. Wake it in Orca, then reconnect.'
      )
    case 'archived':
      return translateMain(
        'components.cloudRemoteDesktop.pageArchived',
        'This workspace is archived. Unarchive it in Orca, then reconnect.'
      )
    case 'starting':
      return translateMain(
        'components.cloudRemoteDesktop.pageStarting',
        'The workspace is starting or waking. Reconnect in a moment.'
      )
    case 'signed_out':
      return translateMain(
        'components.cloudRemoteDesktop.pageSignedOut',
        'You’re signed out of Orca Cloud. Sign in, then reconnect.'
      )
    case 'failed':
    case 'unavailable':
      return translateMain(
        'components.cloudRemoteDesktop.pageDisconnected',
        'The remote desktop disconnected. Your files are safe.'
      )
  }
}
