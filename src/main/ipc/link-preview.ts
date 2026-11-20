import { removeAppHandler, registerAppHandler } from './app-registry/app-handler-registry'

import type { LinkPreviewResult } from '../../shared/browser/link-preview'
import { getLinkPreview } from '../link-preview/link-preview'

export function registerLinkPreviewHandlers(): void {
  removeAppHandler('linkPreview:get')
  registerAppHandler(
    'linkPreview:get',
    async (_event, rawArgs?: unknown): Promise<LinkPreviewResult> => {
      const url =
        rawArgs &&
        typeof rawArgs === 'object' &&
        'url' in rawArgs &&
        typeof rawArgs.url === 'string'
          ? rawArgs.url
          : null
      return url ? getLinkPreview({ url }) : { kind: 'unavailable' }
    }
  )
}
