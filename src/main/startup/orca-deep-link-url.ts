import { isPluginInstallLinkArgument } from '../../shared/plugins/catalog/plugin-install-link'
import { parseSkillShareId } from '../../shared/skill-share-link'
import { parseCloudShareDeepLink } from '../../shared/hosted-sandbox/hosted-sandbox-share-wire'
import { parseCloudWorkspaceLink } from '../../shared/cloud-workspaces/cloud-workspaces-wire'
import { parseOrcaBillingReturnLink } from '../../shared/orca-billing'

/** macOS open-url: claim only links Orca routes, so other schemes keep their default handling. */
export function isRoutedOrcaDeepLink(url: string): boolean {
  return (
    parseSkillShareId(url) !== null ||
    isPluginInstallLinkArgument(url) ||
    parseCloudShareDeepLink(url) !== null ||
    parseCloudWorkspaceLink(url) !== null ||
    parseOrcaBillingReturnLink(url) !== null
  )
}
