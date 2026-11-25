import { defineMethod } from '../../core'
import { LinkPreviewGetParams } from '../../../../../shared/rpc-contract/link-preview/link-preview-params'
import { getLinkPreview } from '../../../../link-preview/link-preview'

export const LINK_PREVIEW_METHODS = [
  defineMethod({
    name: 'linkPreview.get',
    permission: 'workspace',
    share: 'not-shared',
    params: LinkPreviewGetParams,
    handler: async (params) => getLinkPreview({ url: params.url })
  })
]
