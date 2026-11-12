import type { ComponentProps } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import { styles as markdownStyles } from '../../../components/mobile-markdown-styles'
import { typography } from '../../../theme/mobile-theme'
import { MobileNativeChatMarkdown } from './MobileNativeChatMarkdown'

type Props = Pick<
  ComponentProps<typeof MobileNativeChatMarkdown>,
  'content' | 'tone' | 'rangeSelectable'
> & {
  /** The surface's text size; the markdown scales its own sizes to match. */
  fontSize?: number
  /** The question heads its card: larger and strong. */
  title?: boolean
  style?: StyleProp<ViewStyle>
}

/** An agent's question wherever chat shows it: chat markdown, so its file paths open like the rest of the chat. */
export function MobileNativeChatQuestionText({
  fontSize = typography.bodySize,
  title = false,
  tone,
  style,
  content,
  rangeSelectable
}: Props): React.JSX.Element {
  const size = title ? typography.bodySize + 1 : fontSize
  return (
    <View style={style}>
      <MobileNativeChatMarkdown
        content={content}
        rangeSelectable={rangeSelectable}
        tone={title ? 'strong' : tone}
        textScale={size / markdownStyles.paragraph.fontSize}
      />
    </View>
  )
}
