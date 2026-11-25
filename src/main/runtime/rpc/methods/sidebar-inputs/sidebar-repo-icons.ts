import { defineMethod } from '../../core'
import { RepoIconDataUrlsParams } from '../../../../../shared/sidebar-list/catalog/repo-icon-data-urls-contract'

// In every build: the phone's legacy list reads icons by the ids repo.list carries.
export const SIDEBAR_REPO_ICON_METHODS = [
  defineMethod({
    name: 'sidebarInputs.repoIcons',
    permission: 'workspace',
    share: 'not-shared',
    params: RepoIconDataUrlsParams,
    handler: async ({ ids }, { runtime }) => runtime.repoIconDataUrls.read(ids)
  })
]
