import { useMemo, useState } from 'react'
import { FlatList, Keyboard, StyleSheet, View } from 'react-native'
import { MobileSearchField } from '../../../../components/controls/MobileSearchField'
import { MobileNoMatchState } from '../../../../components/feedback/MobileStateView'
import { LIST_ROW_PADDING } from '../../../../components/list/ListGroup'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import { nativeChatSessionChoiceLabel } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-labels'
import {
  nativeChatModelSearchIndex,
  nativeChatModelSearchMatcher
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-model-search'
import { sayMobileNativeChatSessionOption as say } from './native-chat-session-option-copy'
import {
  browsedSelectItems,
  selectItemRow,
  selectListItemKey,
  type SelectListItem
} from './MobileNativeChatSessionOptionRows'

// More than fits one sheet gets a search field; more than two sheets opens on it.
const SEARCH_FROM = 11
const FOCUS_FROM = 31

function browsableCount(model: SessionOptionDescriptor): number {
  return model.kind.type === 'select'
    ? model.kind.choices.filter((choice) => !choice.hidden).length
    : 0
}

/** An agent-picker model is one action row, not a list to search. */
export function modelListNeedsSearch(model: SessionOptionDescriptor | undefined): boolean {
  return model !== undefined && !model.action && browsableCount(model) >= SEARCH_FROM
}

/** The model page of a long catalog (an OpenRouter key lists hundreds): a pinned search over a virtualised list. */
export function MobileNativeChatModelSearchList({
  model,
  disabled,
  moreChoices,
  onSetOption
}: {
  model: SessionOptionDescriptor
  disabled: boolean
  moreChoices: { shown: boolean; onToggle: () => void }
  onSetOption: (value: SessionOptionValue) => void
}): React.JSX.Element {
  const colorScheme = useMobileColorScheme()
  const t = useMobileTranslation()
  const [query, setQuery] = useState('')
  // Decided on arrival, so a listing that grows mid-visit never raises the keyboard.
  const [autoFocus] = useState(() => browsableCount(model) >= FOCUS_FROM)
  const choices = model.kind.type === 'select' ? model.kind.choices : []
  const matches = useMemo(() => nativeChatModelSearchMatcher(query), [query])
  // A search lists every match, search-only and folded models included, as desktop does.
  let items: SelectListItem[]
  if (matches) {
    // Built on a list's first search and reused after, not on every keystroke.
    const texts = nativeChatModelSearchIndex(choices, (choice) =>
      nativeChatSessionChoiceLabel(choice, say, model.id)
    )
    items = choices.filter((choice) => matches(texts.get(choice.value) ?? ''))
  } else {
    items = browsedSelectItems(model, moreChoices)
  }
  const pick = (value: SessionOptionValue): void => {
    Keyboard.dismiss()
    onSetOption(value)
  }
  const only = matches && items.length === 1 ? items[0] : undefined
  return (
    <>
      <MobileSearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t('chat.sessionOptionPickers.searchModels', 'Search models')}
        autoFocus={autoFocus}
        returnKeyType="done"
        onSubmitEditing={() => {
          if (only && typeof only !== 'string' && !disabled && model.settable) {
            pick(only.value)
          }
        }}
        style={styles.search}
      />
      {items.length === 0 ? (
        <MobileNoMatchState
          message={t('chat.sessionOptionPickers.noModelsMatch', 'No models match “{{query}}”', {
            query: query.trim()
          })}
          onClear={() => setQuery('')}
        />
      ) : (
        <FlatList
          data={items}
          extraData={colorScheme}
          keyExtractor={selectListItemKey}
          // Rows are built as they scroll in, so a broad search over hundreds of models stays cheap.
          renderItem={({ item }) =>
            selectItemRow(model, item, { disabled, onSetOption: pick, moreChoices }, t)
          }
          ItemSeparatorComponent={RowSeparator}
          style={styles.group}
          initialNumToRender={16}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        />
      )}
    </>
  )
}

function RowSeparator(): React.JSX.Element {
  useMobileColorScheme()
  return <View style={styles.separator} />
}

const styles = themedStyleSheet(() => ({
  search: {
    marginBottom: spacing.sm
  },
  // ListGroup's surface, as a list that scrolls under the pinned search and shrinks to few matches.
  group: {
    flexGrow: 0,
    flexShrink: 1,
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup,
    overflow: 'hidden'
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: LIST_ROW_PADDING
  }
}))
