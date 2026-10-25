import { Text, View } from 'react-native'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

// Why a placeholder: the native file preview route only mounts the web shell, so the model
// renders in MobileModelPreview.web.tsx; this file keeps the native bundle free of three.js.
export function MobileModelPreview(_props: { base64: string; title: string }) {
  return (
    <View style={styles.state}>
      <Text style={styles.stateText}>3D preview is unavailable here</Text>
    </View>
  )
}
