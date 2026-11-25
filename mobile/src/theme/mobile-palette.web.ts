import { hostOs } from '../platform/host-os'
import * as androidPalette from './mobile-palette.android'
import * as desktopPalette from './mobile-palette-desktop'
import * as iosPalette from './mobile-palette.ios'

// A page in the phone's WebView matches the native screens around it; desktop web keeps desktop's tokens.
const os = hostOs()
const palette = os === 'ios' ? iosPalette : os === 'android' ? androidPalette : desktopPalette

export const { darkPalette, lightPalette } = palette
