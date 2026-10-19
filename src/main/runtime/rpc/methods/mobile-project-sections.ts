import { defineMethod } from '../core'
import { MOBILE_PROJECT_SECTIONS_METHOD } from '../../../../shared/mobile-project-sections-contract'
import { readMobileProjectSections } from '../../mobile-project-sections-snapshot'

export const MOBILE_PROJECT_SECTIONS_METHODS = [
  defineMethod({
    name: MOBILE_PROJECT_SECTIONS_METHOD,
    permission: 'workspace',
    params: null,
    handler: () => readMobileProjectSections()
  })
]
