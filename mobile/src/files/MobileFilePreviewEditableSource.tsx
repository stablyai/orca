import { useEffect, useState } from 'react'
import { Text, TextInput, View } from 'react-native'
import type { MobileFilePreviewLineColumn } from './mobile-file-preview-line-column'
import { textOffsetForLineColumn } from './mobile-file-preview-line-column'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

type Props = {
  title: string
  draftContent: string
  lineColumn: MobileFilePreviewLineColumn | null
  saveError?: string
  onDraftChange: (content: string) => void
}

export function MobileFilePreviewEditableSource({
  title,
  draftContent,
  lineColumn,
  saveError,
  onDraftChange
}: Props) {
  useMobileColorScheme()
  const selectionTargetKey = lineColumn
    ? `${title}:${lineColumn.line}:${lineColumn.column ?? ''}`
    : ''
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null)
  const [revealedTargetKey, setRevealedTargetKey] = useState('')

  // Reveal the requested position once; subsequent cursor movement owns selection.
  useEffect(() => {
    if (!lineColumn || !selectionTargetKey || revealedTargetKey === selectionTargetKey) {
      return
    }
    const offset = textOffsetForLineColumn(draftContent, lineColumn)
    const initialSelection = { start: offset, end: offset }
    setSelection(initialSelection)
    setRevealedTargetKey(selectionTargetKey)
  }, [draftContent, lineColumn, revealedTargetKey, selectionTargetKey])

  return (
    <View style={styles.editContainer}>
      {saveError ? <Text style={styles.saveErrorText}>{saveError}</Text> : null}
      <TextInput
        style={styles.editInput}
        value={draftContent}
        onChangeText={onDraftChange}
        multiline
        textAlignVertical="top"
        autoCapitalize="none"
        autoCorrect={false}
        selection={selection ?? undefined}
        onSelectionChange={() => setSelection(null)}
        accessibilityLabel={`${title} editor`}
      />
    </View>
  )
}
