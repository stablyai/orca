import { Save } from 'lucide-react-native'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export function MobileArtifactSaveButton({
  onPress,
  disabled
}: {
  onPress: () => void
  disabled: boolean
}) {
  const t = useMobileTranslation()
  return (
    <NavBarButton
      icon={Save}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={t('files.filePreviewScreen.saveArtifact', 'Save terminal artifact')}
    />
  )
}
