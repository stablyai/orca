import { Linking } from 'react-native'
import Markdown from 'react-native-markdown-display'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'

type Props = {
  content: string
  // PR body uses a slightly larger base size than inline comment cards (mirrors
  // the desktop document vs comment text sizing).
  variant?: 'document' | 'comment'
}

// Themed markdown for PR bodies + comments — the RN analogue of the desktop
// CommentMarkdown. Muted/monochrome to match the rest of the PR sidebar; code
// blocks get a raised surface and links open in the system browser.
export function CommentMarkdown({ content, variant = 'comment' }: Props) {
  const base = variant === 'document' ? typography.bodySize : 13
  return (
    <Markdown
      style={markdownStyles(base)}
      onLinkPress={(url) => {
        void Linking.openURL(url)
        return false
      }}
    >
      {content}
    </Markdown>
  )
}

function markdownStyles(base: number) {
  return {
    body: { color: colors.textPrimary, fontSize: base, lineHeight: base + 7 },
    paragraph: { marginTop: 0, marginBottom: spacing.sm },
    heading1: {
      color: colors.textPrimary,
      fontSize: base + 4,
      fontWeight: '700',
      marginBottom: spacing.xs
    },
    heading2: {
      color: colors.textPrimary,
      fontSize: base + 3,
      fontWeight: '700',
      marginBottom: spacing.xs
    },
    heading3: {
      color: colors.textPrimary,
      fontSize: base + 1,
      fontWeight: '700',
      marginBottom: spacing.xs
    },
    heading4: { color: colors.textPrimary, fontSize: base, fontWeight: '700' },
    heading5: { color: colors.textPrimary, fontSize: base, fontWeight: '700' },
    heading6: { color: colors.textSecondary, fontSize: base, fontWeight: '700' },
    strong: { fontWeight: '700' },
    em: { fontStyle: 'italic' },
    s: { textDecorationLine: 'line-through' },
    link: { color: colors.textPrimary, textDecorationLine: 'underline' },
    blockquote: {
      backgroundColor: colors.bgRaised,
      borderColor: colors.borderSubtle,
      borderLeftWidth: 3,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      marginBottom: spacing.sm
    },
    code_inline: {
      backgroundColor: colors.bgRaised,
      color: colors.textPrimary,
      fontFamily: typography.monoFamily,
      fontSize: base - 1,
      borderRadius: 4,
      paddingHorizontal: 4
    },
    code_block: codeSurface(base),
    fence: codeSurface(base),
    bullet_list: { marginBottom: spacing.sm },
    ordered_list: { marginBottom: spacing.sm },
    list_item: { color: colors.textPrimary, marginBottom: 2 },
    hr: { backgroundColor: colors.borderSubtle, height: 1, marginVertical: spacing.sm },
    table: {
      borderColor: colors.borderSubtle,
      borderWidth: 1,
      borderRadius: radii.row,
      marginBottom: spacing.sm
    },
    th: { padding: spacing.xs, borderColor: colors.borderSubtle },
    td: { padding: spacing.xs, borderColor: colors.borderSubtle }
  } as const
}

function codeSurface(base: number) {
  return {
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: base - 1,
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radii.row,
    padding: spacing.sm,
    marginBottom: spacing.sm
  } as const
}
