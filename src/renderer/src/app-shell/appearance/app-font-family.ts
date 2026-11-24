import { DEFAULT_APP_FONT_FAMILY } from '../../../../shared/app-lifecycle/appearance/app-font-family'
import { fontFamilyListBuilder } from '../../../../shared/styles/font-family-list'

const APP_FONT_FALLBACKS = [
  DEFAULT_APP_FONT_FAMILY,
  '-apple-system',
  'BlinkMacSystemFont',
  'Segoe UI',
  'sans-serif'
] as const

export const buildAppFontFamily = fontFamilyListBuilder(APP_FONT_FALLBACKS)
