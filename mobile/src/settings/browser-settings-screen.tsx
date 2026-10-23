import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import {
  loadTerminalLinkOpenMode,
  saveTerminalLinkOpenMode,
  type MobileTerminalLinkOpenMode
} from '../storage/preferences'
import { ListRow } from '../components/ui/ListRow'
import { Banner } from '../components/ui/Banner'
import { triggerSelection } from '../platform/haptics'
import { spacing } from '../theme/mobile-theme'
import { SettingsScreen, SettingsSection } from './settings-screen-frame'

const LINK_MODE_OPTIONS: { value: MobileTerminalLinkOpenMode; label: string; subtitle: string }[] =
  [
    {
      value: 'orca-browser',
      label: 'Orca browser on desktop',
      subtitle: 'The streamed browser from your paired desktop.'
    },
    {
      value: 'phone-browser',
      label: 'Phone browser',
      subtitle: 'Safari, Chrome or another browser on this phone.'
    }
  ]

export default function BrowserSettingsScreen({
  onBack
}: {
  onBack?: () => void
}): React.JSX.Element {
  const [linkMode, setLinkMode] = useState<MobileTerminalLinkOpenMode>('orca-browser')
  const [error, setError] = useState<string | null>(null)
  const selectionRevision = useRef(0)
  const failedSelectionRevision = useRef<number | null>(null)
  const savedMode = useRef<MobileTerminalLinkOpenMode>('orca-browser')
  const hasSaved = useRef(false)

  useEffect(() => {
    let active = true
    void loadTerminalLinkOpenMode().then(
      (mode) => {
        if (!hasSaved.current) {
          savedMode.current = mode
        }
        if (
          active &&
          (selectionRevision.current === 0 ||
            failedSelectionRevision.current === selectionRevision.current)
        ) {
          setLinkMode(savedMode.current)
        }
      },
      () => {
        if (active) {
          setError('Could not load browser preferences. Try again.')
        }
      }
    )
    return () => {
      active = false
    }
  }, [])

  const selectLinkMode = useCallback((mode: MobileTerminalLinkOpenMode) => {
    setError(null)
    const revision = ++selectionRevision.current
    setLinkMode(mode)
    void saveTerminalLinkOpenMode(mode).then(
      () => {
        savedMode.current = mode
        hasSaved.current = true
      },
      () => {
        if (revision === selectionRevision.current) {
          failedSelectionRevision.current = revision
          setLinkMode(savedMode.current)
          setError('Could not save browser preferences. Try again.')
        }
      }
    )
  }, [])

  return (
    <SettingsScreen title="Browser" onBack={onBack}>
      {error ? (
        <View style={styles.banner}>
          <Banner tone="error" message={error} onDismiss={() => setError(null)} />
        </View>
      ) : null}
      <SettingsSection
        title="Open terminal links in"
        first
        footer="Applies to http and https links tapped in terminal output."
      >
        {LINK_MODE_OPTIONS.map((option) => (
          <ListRow
            key={option.value}
            title={option.label}
            subtitle={option.subtitle}
            selected={linkMode === option.value}
            onPress={() => {
              if (linkMode !== option.value) {
                triggerSelection()
                selectLinkMode(option.value)
              }
            }}
          />
        ))}
      </SettingsSection>
    </SettingsScreen>
  )
}

const styles = StyleSheet.create({
  banner: { paddingTop: spacing.sm, paddingBottom: spacing.xs }
})
