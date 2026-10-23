import { StyleSheet, View } from 'react-native'
import { spacing } from '../theme/mobile-theme'
import { Banner } from './ui/Banner'

/**
 * One dismissible notice above the list, in two tones.
 *
 * `notice` is the default and stays monochrome: the host is healthy and the user's target simply
 * went away. `failure` is for an action that did not happen, which the list has to say without
 * taking the screen, so it takes the error tone and nothing more.
 *
 * Both are inserted into a screen that is already on screen, so a reader who has moved past the top
 * of the list never arrives at one. The tone decides how loudly it is carried to them: a refusal
 * interrupts, and a bounced route waits its turn, because interrupting for the second would train
 * people to ignore the first. The error banner carries the `alert` role itself; the notice gets the
 * polite region alone, since React Native has no `status` role.
 */
export function HostRouteNoticeBanner({
  message,
  tone = 'notice',
  onDismiss
}: {
  message: string
  tone?: 'notice' | 'failure'
  onDismiss: () => void
}) {
  return (
    <View
      style={styles.frame}
      accessibilityLiveRegion={tone === 'failure' ? 'assertive' : 'polite'}
    >
      <Banner
        tone={tone === 'failure' ? 'error' : 'info'}
        message={message}
        onDismiss={onDismiss}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  frame: { paddingTop: spacing.sm, paddingBottom: spacing.xs }
})
