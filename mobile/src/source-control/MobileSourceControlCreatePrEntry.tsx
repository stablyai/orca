import { Text, View } from 'react-native'
import { GitPullRequestArrow } from 'lucide-react-native'
import { Button } from '../components/ui/Button'
import type { MobileCreatePrAction } from './mobile-create-pr-action'
import { styles } from './mobile-source-control-styles'

type Props = {
  action: MobileCreatePrAction
}

export function MobileSourceControlCreatePrEntry({ action }: Props) {
  // Blocked, it says nothing here: the PR row above opens the tab that explains why.
  if (!action.visible || action.disabled) {
    return null
  }
  // Ready to open a PR straight away, it is the screen's one primary; the commit bar steps back.
  const hero = !action.disabled && !action.pushFirst
  return (
    <View style={styles.createPrBlock}>
      <Button
        label={action.label}
        icon={GitPullRequestArrow}
        variant={hero ? 'primary' : 'secondary'}
        size="large"
        block
        busy={action.loading}
        disabled={action.disabled}
        onPress={action.onPress}
        accessibilityHint={action.hint}
      />
      {action.hint ? <Text style={styles.createPrHint}>{action.hint}</Text> : null}
    </View>
  )
}
