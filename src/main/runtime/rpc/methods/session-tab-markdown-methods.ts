import { defineMethod } from '../core'
import {
  ActivateTab,
  SaveMarkdownTab
} from '../../../../shared/rpc-contract/session-tabs-schemas-params'

export const SESSION_TAB_MARKDOWN_METHODS = [
  defineMethod({
    name: 'markdown.readTab',
    permission: 'workspace',
    params: ActivateTab,
    handler: async (params, { runtime }) =>
      runtime.readMobileMarkdownTab(params.worktree, params.tabId)
  }),
  defineMethod({
    name: 'markdown.saveTab',
    permission: 'workspace',
    params: SaveMarkdownTab,
    handler: async (params, { runtime }) =>
      runtime.saveMobileMarkdownTab(
        params.worktree,
        params.tabId,
        params.baseVersion,
        params.content
      )
  })
]
