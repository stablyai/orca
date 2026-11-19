import type { ComponentProps } from 'react'
import { View } from 'react-native'
import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { AiVaultScope } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import { AgentHistoryViewControls } from './AgentHistoryViewControls'
import { scopeSegments } from './agent-history-scope-segments'
import { styles } from './agent-history-styles'

/** The scope switch with History's agent filter and sort under it. */
export function AgentHistoryScopeControls({
  scope,
  onSelectScope,
  ...viewControls
}: ComponentProps<typeof AgentHistoryViewControls> & {
  scope: AiVaultScope
  onSelectScope: (scope: AiVaultScope) => void
}) {
  const t = useMobileTranslation()
  return (
    <View>
      <MobileSegmentedControl
        segments={scopeSegments(t)}
        selected={scope}
        onSelect={onSelectScope}
        fill
        style={styles.scopeTabs}
      />
      <AgentHistoryViewControls {...viewControls} />
    </View>
  )
}
