import { defineMethod } from '../core'
import { MOBILE_PROJECT_SECTIONS_METHOD } from '../../../../shared/mobile-project-sections-contract'
import { readSidebarProjectCatalog } from '../../sidebar-inputs/sidebar-project-catalog'

export const MOBILE_PROJECT_SECTIONS_METHODS = [
  defineMethod({
    name: MOBILE_PROJECT_SECTIONS_METHOD,
    permission: 'workspace',
    params: null,
    // For a page that predates the feed's projectCatalog domain: main's own catalog.
    handler: (_params, { runtime }) => ({
      catalog: readSidebarProjectCatalog(
        runtime.requireStore(),
        runtime.pairedServerRows.catalogs()
      )
    })
  })
]
