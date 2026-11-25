import { useState, type ReactElement } from 'react'
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
import { descriptorRowElements, searchedChoices } from './MobileNativeChatSessionOptionRows'

// More than fits one sheet gets a search field; more than two sheets opens on it.
const SEARCH_FROM = 11
const FOCUS_FROM = 31

function browsableCount(model: SessionOptionDescriptor): number {
  return model.kind.type === 'select'
    ? model.kind.choices.filter((choice) => !choice.hidden).length
    : 0
}

export function modelListNeedsSearch(model: SessionOptionDescriptor | undefined): boolean {
  return model !== undefined && browsableCount(model) >= SEARCH_FROM
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
  const pick = (value: SessionOptionValue): void => {
    Keyboard.dismiss()
    onSetOption(value)
  }
  const rows = descriptorRowElements(
    {
      descriptor: model,
      disabled,
      onSetOption: pick,
      onInvokeAction: () => {},
      moreChoices,
      query
    },
    t
  )
  const pickOnlyMatch = (): void => {
    const matches = searchedChoices(model, query)
    if (matches?.length === 1 && !disabled) {
      pick(matches[0]!.value)
    }
  }
  return (
    <>
      <MobileSearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t('chat.sessionOptionPickers.searchModels', 'Search models')}
        autoFocus={browsableCount(model) >= FOCUS_FROM}
        returnKeyType="done"
        onSubmitEditing={pickOnlyMatch}
        style={styles.search}
      />
      {rows.length === 0 ? (
        <MobileNoMatchState
          message={t('chat.sessionOptionPickers.noModelsMatch', 'No models match “{{query}}”', {
            query: query.trim()
          })}
          onClear={() => setQuery('')}
        />
      ) : (
        <FlatList
          data={rows}
          extraData={colorScheme}
          keyExtractor={rowKey}
          renderItem={renderRow}
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

const rowKey = (row: ReactElement): string => String(row.key)
const renderRow = ({ item }: { item: ReactElement }): ReactElement => item

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
