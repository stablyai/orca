import { withLiveCatalogListing } from '../../native-chat/agent-model-catalog/agent-model-catalog-entry'
import type { AcpStructuredOptions } from './acp-structured-options'
import { acpSessionAcceptsImages } from '../protocol/acp-image-capability'

export async function readAcpLiveOptions(
  session: Parameters<typeof acpSessionAcceptsImages>[0] & { options: AcpStructuredOptions },
  permissionModes?: Readonly<Partial<Record<string, string>>>
) {
  const acceptsImages = await acpSessionAcceptsImages(session)
  // Only startup establishes config resolution; later reads may reflect changed picks.
  const options = withLiveCatalogListing(session.options.read())
  return {
    ...options,
    current: {
      ...options.current,
      reportedPermissionMode: session.options.reportedPermissionMode(permissionModes)
    },
    acceptsImages
  }
}
