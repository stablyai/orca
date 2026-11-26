import { Fragment } from 'react'
import { Text } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { mobileForkMark, mobileForkMarkedNameParts } from './mobile-fork-marked-name'

/** Nested in a title's Text: the muted "Fork ·" mark and the name, in the locale's order. */
export function MobileForkMarkedName({
  name,
  sideChat = false
}: {
  name: string
  sideChat?: boolean
}): React.JSX.Element {
  useMobileColorScheme()
  // Re-renders with the language; the parts read the current translation.
  const t = useMobileTranslation()
  return (
    <>
      {mobileForkMarkedNameParts().map((part) => (
        <Fragment key={part.key}>
          {part.kind === 'mark' ? (
            <Text style={styles.mark}>
              {sideChat ? t('session.currentSideChat.mark', 'btw') : mobileForkMark()}
            </Text>
          ) : part.kind === 'name' ? (
            name
          ) : (
            part.text
          )}
        </Fragment>
      ))}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  mark: { color: colors.textMuted }
}))
