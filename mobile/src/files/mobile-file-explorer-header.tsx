import { View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { X } from 'lucide-react-native'
import { IconButton } from '../components/ui/IconButton'
import { NavBar } from '../components/ui/NavBar'
import { fileExplorerStyles as styles } from './mobile-file-explorer-styles'

/** The explorer's bar: Close when docked beside a session, Back when it has the screen. */
export function MobileFileExplorerHeader(props: {
  subtitle: string
  embedded: boolean
  scrolled: boolean
  onClose: () => void
  onBack: () => void
}) {
  if (props.embedded) {
    // The dock column owns the safe area, so the docked bar takes no inset.
    return (
      <View style={styles.header}>
        <NavBar
          title="Files"
          subtitle={props.subtitle}
          scrolled={props.scrolled}
          trailing={
            <IconButton icon={X} accessibilityLabel="Close files" onPress={props.onClose} />
          }
        />
      </View>
    )
  }
  return (
    <SafeAreaView style={styles.header} edges={['top']}>
      <NavBar
        title="Files"
        subtitle={props.subtitle}
        onBack={props.onBack}
        backAccessibilityLabel="Back to session"
        scrolled={props.scrolled}
      />
    </SafeAreaView>
  )
}
