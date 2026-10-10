import type { ImageSourcePropType } from 'react-native'
import type { AppIconId } from '../../../src/shared/app-icon'

// Metro needs static require() paths. These are the same PNGs the config plugin compiles as icons.
export const APP_ICON_PREVIEW_ASSETS = {
  classic: require('../../assets/icon.png'),
  watercolor: require('../../assets/app-icons/orca-watercolor.png'),
  blue: require('../../assets/app-icons/orca-blue.png')
} satisfies Record<AppIconId, ImageSourcePropType>
