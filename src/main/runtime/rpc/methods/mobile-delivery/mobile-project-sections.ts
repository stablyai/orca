import { defineMethod } from '../../core'
import { MOBILE_PROJECT_SECTIONS_METHOD } from '../../../../../shared/mobile-project-sections-contract'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../shared/sidebar-inputs-switch'
import { readMobileProjectSections } from '../../../sidebar-inputs/catalog/mobile-project-sections-snapshot'
import { requireSwitchedOn } from '../../../construction/require-sidebar-inputs-enabled'
import { readSidebarProjectCatalog } from '../../../sidebar-inputs/catalog/sidebar-project-catalog'

export const MOBILE_PROJECT_SECTIONS_METHODS = [
  defineMethod({
    name: MOBILE_PROJECT_SECTIONS_METHOD,
    permission: 'workspace',
    params: null,
    // Switch point: for a page that predates the feed's projectCatalog domain, main's own catalog.
    handler: (_params, { runtime }) =>
      ORCA_SIDEBAR_INPUTS_IS_MAIN
        ? {
            catalog: readSidebarProjectCatalog(
              runtime.requireStore(),
              requireSwitchedOn(runtime.pairedServerRows).catalogs()
            )
          }
        : readMobileProjectSections()
  })
]
