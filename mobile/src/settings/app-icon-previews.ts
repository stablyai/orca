import type { ImageSourcePropType } from 'react-native'
import type { AppIconId } from '../../../src/shared/app-icon'

// Keep literal require paths: Metro cannot resolve dynamic asset paths.
export const APP_ICON_PREVIEWS: Readonly<Record<AppIconId, ImageSourcePropType>> = {
  classic: require('../../assets/app-icons/classic-preview.png'),
  watercolor: require('../../assets/app-icons/watercolor-preview.png'),
  blue: require('../../assets/app-icons/blue-preview.png')
}
