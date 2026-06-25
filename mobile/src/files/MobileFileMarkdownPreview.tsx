import { useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { Code, Eye } from 'lucide-react-native'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { colors } from '../theme/mobile-theme'
import {
  MobileFilePreviewSourceText,
  MobileFilePreviewTruncatedNote
} from './MobileFilePreviewSourceText'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

type Props = {
  relativePath: string
  content: string
  truncated: boolean
  byteLength: number
}

export function MobileFileMarkdownPreview({ relativePath, content, truncated, byteLength }: Props) {
  const [mode, setMode] = useState<'preview' | 'source'>('preview')

  return (
    <View style={styles.modeContainer}>
      <View style={styles.modeToolbar}>
        <Pressable
          style={[styles.modeToggle, mode === 'preview' && styles.modeToggleActive]}
          onPress={() => setMode('preview')}
          accessibilityLabel="View rendered Markdown preview"
        >
          <Eye size={13} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.modeToggleText}>Preview</Text>
        </Pressable>
        <Pressable
          style={[styles.modeToggle, mode === 'source' && styles.modeToggleActive]}
          onPress={() => setMode('source')}
          accessibilityLabel="View Markdown source"
        >
          <Code size={13} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.modeToggleText}>Source</Text>
        </Pressable>
      </View>
      {mode === 'preview' ? (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.markdownContent}>
          {truncated ? <MobileFilePreviewTruncatedNote byteLength={byteLength} /> : null}
          <MobileMarkdown content={content} />
        </ScrollView>
      ) : (
        <MobileFilePreviewSourceText
          relativePath={relativePath}
          content={content}
          truncated={truncated}
          byteLength={byteLength}
        />
      )}
    </View>
  )
}
