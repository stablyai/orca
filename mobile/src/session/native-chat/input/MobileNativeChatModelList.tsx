import { useState } from 'react'
import { Keyboard, ScrollView, View } from 'react-native'
import { ListGroup } from '../../../components/list/ListGroup'
import { MobileSearchField } from '../../../components/MobileSearchField'
import { spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import { descriptorRowElements, SessionOptionCaption } from './MobileNativeChatSessionOptionRows'

export function MobileNativeChatModelList(props: {
  descriptor: SessionOptionDescriptor
  disabled: boolean
  onSetOption: (value: SessionOptionValue) => void
  onInvokeAction: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [query, setQuery] = useState('')
  const rows = descriptorRowElements({ ...props, query }, t)
  return (
    <View style={styles.body}>
      <MobileSearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t('chat.sessionOptionPickers.searchModels', 'Search models…')}
        onSubmitEditing={Keyboard.dismiss}
        style={styles.search}
      />
      <ScrollView
        key={query}
        style={styles.list}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator
      >
        <ListGroup>{rows}</ListGroup>
        {rows.length === 0 ? (
          <SessionOptionCaption>
            {t('chat.sessionOptionPickers.noModelsMatch', 'No models match your search.')}
          </SessionOptionCaption>
        ) : null}
      </ScrollView>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  body: { flex: 1, minHeight: 0 },
  search: { marginBottom: spacing.sm },
  list: { flex: 1, minHeight: 0 }
}))
