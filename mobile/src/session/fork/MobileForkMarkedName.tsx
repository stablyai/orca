import { Fragment } from 'react'
import { Text } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { mobileForkMark, mobileForkMarkedNameParts } from './mobile-fork-marked-name'

/** Nested in a title's Text: the muted "Fork ·" mark and the name, in the locale's order. */
export function MobileForkMarkedName({ name }: { name: string }): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  return (
    <>
      {mobileForkMarkedNameParts(t).map((part) => (
        <Fragment key={part.key}>
          {part.kind === 'mark' ? (
            <Text style={styles.mark}>{mobileForkMark(t)}</Text>
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

const stylesSheet = themedStyleSheet((colors) => ({
  mark: { color: colors.textMuted }
}))
