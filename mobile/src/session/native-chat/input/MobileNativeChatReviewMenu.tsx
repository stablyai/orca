import { useMemo, useState, useSyncExternalStore } from 'react'
import { FlatList, View } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import type { NativeChatReviewMenu } from '../../../../../src/shared/native-chat/input/native-chat-review-menu'
import { ListRow } from '../../../components/list/ListRow'
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
          title="Review changes"
          trailing={{
            label: state.page === 'custom' ? 'Run' : 'Done',
            onPress: () => (state.page === 'custom' ? submit(menu.submit(query)) : onClose())
          }}
        />
        {state.page !== 'review' && (
          <View style={styles.back}>
            <NavBarButton
              icon={ChevronLeft}
              accessibilityLabel="Back to review targets"
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
              ? 'Enter review instructions'
              : state.page === 'baseBranch'
                ? 'Search branches…'
                : 'Search commits…'
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
