import { expect, it } from 'vitest'
import { readBrowserPageStateFormData } from './browser-page-state-form-data'
import {
  GET_PAGE_STATE,
  GET_PAGE_STATE_NAMING_A_TYPE,
  GET_PAGE_STATE_SAVING_A_TYPE,
  POST_PAGE_STATE
} from './browser-page-state-form-data.test-fixture'

it('counts only a content-type field, not an address or saved form value that names one', () => {
  expect(readBrowserPageStateFormData(POST_PAGE_STATE)).toBe('form-data')
  expect(readBrowserPageStateFormData(GET_PAGE_STATE)).toBe('none')
  expect(readBrowserPageStateFormData(GET_PAGE_STATE_NAMING_A_TYPE)).toBe('none')
  expect(readBrowserPageStateFormData(GET_PAGE_STATE_SAVING_A_TYPE)).toBe('none')
})
