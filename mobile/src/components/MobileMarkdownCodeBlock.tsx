import { memo, useMemo } from 'react'
import { Text, View } from 'react-native'
import { highlightMobileCode } from '../session/mobile-file-syntax'
import { MobileSyntaxSegments } from './MobileSyntaxSegments'
import { styles } from './mobile-markdown-styles'

/** A fenced code block with lowlight syntax highlighting. Memoized so only the
 *  block whose text actually changed re-tokenizes — during streaming that's just
 *  the growing tail block, not every earlier one. The mono font/size comes from
 *  the wrapping Text; each segment only overrides color. */
function MobileMarkdownCodeBlockImpl({
  code,
  language
}: {
  code: string
  language?: string
}): React.JSX.Element {
  const { segments } = useMemo(
    () => highlightMobileCode(code, language ?? ''),
    [code, language]
  )
  return (
    <View style={styles.codeBlock}>
      {language ? <Text style={styles.codeLanguage}>{language}</Text> : null}
      <Text selectable style={styles.codeText}>
        <MobileSyntaxSegments segments={segments} />
      </Text>
    </View>
  )
}

export const MobileMarkdownCodeBlock = memo(MobileMarkdownCodeBlockImpl)
