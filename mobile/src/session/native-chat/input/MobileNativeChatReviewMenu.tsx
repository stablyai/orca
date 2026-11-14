import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { FlatList, View } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import type { NativeChatReviewMenu } from '../../../../../src/shared/native-chat/input/native-chat-review-menu'
import { ListRow } from '../../../components/list/ListGroup'
import { SheetHeader } from '../../../components/nav-bar/SheetHeader'
import { NavBarButton } from '../../../components/nav-bar/NavBarButton'
import { TextField } from '../../../components/composer-input/TextField'
import { sessionOptionPickerStyles as styles } from './mobile-native-chat-session-option-picker-styles'

export function MobileNativeChatReviewMenu({
  menu,
  onClose
}: {
  menu: NativeChatReviewMenu
  onClose: () => void
}): React.JSX.Element {
  const state = useSyncExternalStore(menu.subscribe, menu.getSnapshot)
  return <ReviewPage key={state.page} menu={menu} onClose={onClose} />
}

function ReviewPage({
  menu,
  onClose
}: {
  menu: NativeChatReviewMenu
  onClose: () => void
}): React.JSX.Element {
  const state = useSyncExternalStore(menu.subscribe, menu.getSnapshot)
  const t = useMobileTranslation()
  const [query, setQuery] = useState('')
  const choices = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    return state.choices.filter((choice) =>
      terms.every((term) =>
        `${choice.label} ${choice.description ?? ''} ${choice.value}`.toLowerCase().includes(term)
      )
    )
  }, [query, state.choices])
  const submit = (run: Promise<boolean>) => {
    void run.then((accepted) => {
      if (accepted) {
        onClose()
      }
    })
  }
  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <SheetHeader
          title={t('nativeChat.review.title', 'Review changes')}
          trailing={{
            label:
              state.page === 'custom'
                ? t('nativeChat.review.run', 'Run')
                : t('nativeChat.review.done', 'Done'),
            onPress: () => (state.page === 'custom' ? submit(menu.submit(query)) : onClose())
          }}
        />
        {state.page !== 'review' && (
          <View style={styles.back}>
            <NavBarButton
              icon={ChevronLeft}
              accessibilityLabel={t('nativeChat.review.back', 'Back to review targets')}
              onPress={menu.back}
            />
          </View>
        )}
      </View>
      {state.page !== 'review' && (
        <TextField
          value={query}
          onChangeText={setQuery}
          editable={!state.busy}
          placeholder={
            state.page === 'custom'
              ? t('nativeChat.review.instructions', 'Enter review instructions')
              : state.page === 'baseBranch'
                ? t('nativeChat.review.searchBranches', 'Search branches…')
                : t('nativeChat.review.searchCommits', 'Search commits…')
          }
          returnKeyType={state.page === 'custom' ? 'send' : 'search'}
          onSubmitEditing={() => {
            if (state.page === 'custom' && !state.busy) {
              submit(menu.submit(query))
            }
          }}
        />
      )}
      <FlatList
        data={choices}
        keyExtractor={(choice) => choice.value}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={3}
        keyboardShouldPersistTaps="handled"
        style={styles.reviewList}
        renderItem={({ item }) => (
          <ListRow
            title={item.label}
            subtitle={item.description}
            disabled={state.busy}
            onPress={() => submit(menu.select(item.value))}
          />
        )}
      />
    </View>
  )
}
