import { Image, ScrollView, Text, View } from 'react-native'
import { MobileHtmlPreview } from '../../../../src/components/MobileHtmlPreview'
import { MobileSyntaxSegments } from '../../../../src/components/MobileSyntaxSegments'
import type { MobileSyntaxSegment } from '../../../../src/session/mobile-file-syntax'
import type { FileDocState } from './mobile-session-route-types'
import { styles } from './mobile-session-styles'

type PreviewDoc = Exclude<Extract<FileDocState, { status: 'ready' }>, { kind: 'diff' }>

type Props = {
  doc: PreviewDoc
  title: string
  syntaxSegments?: MobileSyntaxSegment[]
}

export function MobileFilePreviewContent({ doc, title, syntaxSegments }: Props) {
  if (doc.kind === 'image') {
    return (
      <View style={styles.imagePreviewContainer}>
        <ScrollView
          style={styles.imagePreviewScroll}
          contentContainerStyle={styles.imagePreviewContent}
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
        >
          <Image
            source={{ uri: doc.dataUri }}
            style={styles.imagePreview}
            resizeMode="contain"
            accessibilityLabel={`${title} image`}
          />
        </ScrollView>
      </View>
    )
  }

  const segments = syntaxSegments ?? [{ text: doc.content, kind: 'plain' as const }]
  const renderSource = () => (
    <View style={styles.markdownEditor}>
      <ScrollView
        style={styles.filePreviewScroll}
        contentContainerStyle={styles.filePreviewContent}
      >
        <Text selectable style={styles.filePreviewText} accessibilityLabel={`${title} preview`}>
          <MobileSyntaxSegments segments={segments} />
        </Text>
      </ScrollView>
    </View>
  )

  return doc.kind === 'html' ? (
    <View style={styles.markdownEditor}>
      <MobileHtmlPreview html={doc.content} renderSource={renderSource} />
    </View>
  ) : (
    renderSource()
  )
}
