import { defineMethod } from '../../core'
import {
  ActivateTab,
  SaveMarkdownTab
} from '../../../../../shared/rpc-contract/session-tabs/session-tabs-schemas-params'

export const SESSION_TAB_MARKDOWN_METHODS = [
  defineMethod({
    name: 'markdown.readTab',
    permission: 'workspace',
    share: 'not-shared',
    params: ActivateTab,
    handler: async (params, { runtime, callerScope }) =>
      runtime.readMobileMarkdownTab(
        await runtime.tabListSelectorOf(params.worktree, callerScope),
        params.tabId
      )
  }),
  defineMethod({
    name: 'markdown.saveTab',
    permission: 'workspace',
    share: 'not-shared',
    params: SaveMarkdownTab,
    handler: async (params, { runtime, callerScope }) =>
      runtime.saveMobileMarkdownTab(
        await runtime.tabListSelectorOf(params.worktree, callerScope),
        params.tabId,
        params.baseVersion,
        params.content
      )
  })
]
