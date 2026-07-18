import { runHostCredentialWriteForExistingHost } from './host-store'
import {
  writeMobileRelayCredentialBundle,
  type MobileRelayCredentialBundle
} from './mobile-relay-credential-bundle'
import {
  writeMobileRelayDirectUpgradeJournal,
  type MobileRelayDirectUpgradeJournal
} from './mobile-relay-direct-upgrade-journal'

export function writeMobileRelayCredentialBundleForExistingHost(
  bundle: MobileRelayCredentialBundle
): Promise<void> {
  return runHostCredentialWriteForExistingHost(bundle.hostId, () =>
    writeMobileRelayCredentialBundle(bundle)
  )
}

export function writeMobileRelayDirectUpgradeJournalForExistingHost(
  journal: MobileRelayDirectUpgradeJournal
): Promise<void> {
  return runHostCredentialWriteForExistingHost(journal.hostId, () =>
    writeMobileRelayDirectUpgradeJournal(journal)
  )
}
