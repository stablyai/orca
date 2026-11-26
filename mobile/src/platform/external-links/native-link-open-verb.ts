import { linkOpenParamsSchema } from '../../mobile-web-shell/bridge/native-capabilities/bridge-native-verbs'
import { readBridgeExternalLinkUrl } from '../../mobile-web-shell/bridge/protocol/bridge-caps'
import { openExternalLink } from './external-link'

/** Opens a page's link on the phone and says whether an app took it; only the schemes the externalLink notify allows. */
export async function serveNativeLinkOpenVerb(params: unknown): Promise<{ opened: boolean }> {
  const target = readBridgeExternalLinkUrl(linkOpenParamsSchema.parse(params).url)
  return { opened: target !== null && (await openExternalLink(target)) }
}
