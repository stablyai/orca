import { useMemo } from 'react'
import { Pressable, Text, View } from 'react-native'
import { MobileNativeChatOwnedScrollView } from './MobileNativeChatOwnedScrollView'
import { ChevronRight, FileMinus2, FilePen, FilePlus2 } from 'lucide-react-native'
import {
  NATIVE_CHAT_DIFF_CARD_COPY,
  nativeChatEditFilePatchText
} from '../../../src/shared/native-chat-edit-cards'
import {
  unifiedLineNumber,
  type NativeChatEditFile,
  type NativeChatEditLine
} from '../../../src/shared/native-chat-edit-model'
import { NATIVE_CHAT_TOOL_ROW_VERB_COPY } from '../../../src/shared/native-chat-tool-line-label'
import { MobileSourceCopyButton } from '../components/MobileSourceCopyButton'
import { colors } from '../theme/mobile-theme'
import { useMobileNativeChatOpenedDetail } from './mobile-native-chat-opened-detail'
import { useMobileNativeChatDisclosure } from './mobile-native-chat-disclosure-store'
import { toolStyles as styles, toolType } from './mobile-native-chat-tool-styles'

function baseName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path
}

function VerbIcon({ kind, size }: { kind: NativeChatEditFile['changeKind']; size: number }) {
  const Icon = kind === 'added' ? FilePlus2 : kind === 'deleted' ? FileMinus2 : FilePen
  return <Icon size={size} color={colors.textMuted} strokeWidth={2} />
}

function DiffRow({
  line,
  gutterChars,
  type
}: {
  line: NativeChatEditLine
  gutterChars: number
  type: ReturnType<typeof toolType>['code']
}): React.JSX.Element {
  if (line.kind === 'gap') {
    // The break between two regions of the file, so the gutter's jump is accounted for.
    return (
      <Text style={[styles.diffGap, type]} accessibilityLabel={NATIVE_CHAT_DIFF_CARD_COPY.diffGap}>
        ⋯
      </Text>
    )
  }
  return (
    <View
      style={[
        styles.diffRow,
        line.kind === 'add' && styles.diffAddGround,
        line.kind === 'del' && styles.diffDelGround
      ]}
    >
      {gutterChars > 0 ? (
        <Text
          style={[
            styles.codeText,
            styles.diffGutter,
            type,
            { width: gutterChars * type.fontSize * 0.62 },
            line.kind === 'add' && styles.diffAddGutter,
            line.kind === 'del' && styles.diffDelGutter
          ]}
        >
          {unifiedLineNumber(line) ?? ''}
        </Text>
      ) : null}
      <Text
        style={[
          styles.codeText,
          styles.diffSign,
          type,
          line.kind === 'add' && styles.diffAddText,
          line.kind === 'del' && styles.diffDelText
        ]}
      >
        {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
      </Text>
      <Text style={[styles.codeText, styles.diffText, type]}>{line.text}</Text>
    </View>
  )
}

/** The card's rows in their own bounded box. Its own component so a collapsed card
 *  builds none of them. */
function DiffCardRows({
  file,
  fontScale,
  disclosureKey,
  rootIdentity
}: {
  file: NativeChatEditFile
  fontScale: number
  disclosureKey?: string
  rootIdentity?: string
}) {
  const onLayout = useMobileNativeChatOpenedDetail()
  const type = toolType(fontScale).code
  // A snippet-relative number would read as a file position, so the gutter is blank
  // unless the provider resolved the ranges.
  const widest = file.lineNumbersKnown
    ? file.lines.reduce((max, line) => Math.max(max, unifiedLineNumber(line) ?? 0), 0)
    : 0
  const gutterChars = file.lineNumbersKnown ? Math.max(3, String(widest).length + 1) : 0
  // Desktop's row identity: the line itself, and which repeat of it this is.
  const seen = new Map<string, number>()
  return (
    <MobileNativeChatOwnedScrollView
      rootIdentity={rootIdentity ?? `diff:${file.path}`}
      positionKey={disclosureKey ?? `diff:${file.path}`}
      style={[styles.codeBox, styles.diffBody]}
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      onLayout={onLayout}
    >
      {file.lines.map((line) => {
        const signature = `${line.kind}:${line.oldLineNumber}:${line.newLineNumber}:${line.text}`
        const occurrence = seen.get(signature) ?? 0
        seen.set(signature, occurrence + 1)
        return (
          <DiffRow
            key={`${signature}:${occurrence}`}
            line={line}
            gutterChars={gutterChars}
            type={type}
          />
        )
      })}
    </MobileNativeChatOwnedScrollView>
  )
}

/** Desktop parity: `NativeChatDiffCard`. One file an agent changed: its verb, name and
 *  counts, opening to the unified rows. A change with no body keeps only its header. */
export function MobileNativeChatDiffCard({
  file,
  fontScale,
  defaultExpanded = false,
  disclosureKey,
  rootIdentity,
  onOpenFile
}: {
  file: NativeChatEditFile
  fontScale: number
  defaultExpanded?: boolean
  /** Identity this card's open state is remembered under while it is unmounted. */
  disclosureKey?: string
  rootIdentity?: string
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useMobileNativeChatDisclosure(disclosureKey, defaultExpanded)
  const hasBody = file.lines.length > 0
  const copyText = useMemo(() => nativeChatEditFilePatchText(file.lines), [file.lines])
  const type = toolType(fontScale)
  const iconSize = 15 * fontScale
  // A deleted file has nothing left to open.
  const openFile = file.changeKind === 'deleted' ? undefined : onOpenFile
  return (
    <View>
      <View style={styles.cardHeader}>
        <Pressable
          style={[styles.line, styles.cardToggle]}
          onPress={() => hasBody && setExpanded(!expanded)}
          disabled={!hasBody}
          accessibilityRole="button"
          accessibilityState={hasBody ? { expanded } : undefined}
        >
          <View style={[styles.iconSlot, { width: iconSize }]}>
            <VerbIcon kind={file.changeKind} size={iconSize} />
          </View>
          <Text style={[styles.lineWord, type.row]}>
            {NATIVE_CHAT_TOOL_ROW_VERB_COPY[file.changeKind]}
          </Text>
          {file.oldPath ? (
            <>
              <Text
                style={[styles.lineWord, styles.shrinkable, styles.struck, type.row]}
                numberOfLines={1}
                accessibilityLabel={file.oldPath}
              >
                {baseName(file.oldPath)}
              </Text>
              <Text style={[styles.lineWord, type.row]}>→</Text>
            </>
          ) : null}
          <Text
            style={[styles.lineTarget, type.row, openFile && styles.lineLink]}
            numberOfLines={1}
            onPress={openFile ? () => openFile(file.path) : undefined}
            suppressHighlighting={!openFile}
            accessibilityRole={openFile ? 'link' : undefined}
          >
            {baseName(file.path)}
          </Text>
          <Text style={[styles.lineMeta, type.meta]}>
            {file.added > 0 ? <Text style={styles.countAdded}>{`+${file.added}`}</Text> : null}
            {file.added > 0 && file.removed > 0 ? ' ' : null}
            {file.removed > 0 ? (
              <Text style={styles.countRemoved}>{`-${file.removed}`}</Text>
            ) : null}
          </Text>
          {file.truncated ? (
            <Text style={[styles.lineMeta, type.meta]}>
              {NATIVE_CHAT_DIFF_CARD_COPY.diffTruncated}
            </Text>
          ) : null}
          {hasBody ? (
            <View style={expanded ? styles.caretOpen : undefined}>
              <ChevronRight size={14 * fontScale} color={colors.textMuted} strokeWidth={2} />
            </View>
          ) : null}
        </Pressable>
        <MobileSourceCopyButton
          text={copyText}
          accessibilityLabel={NATIVE_CHAT_DIFF_CARD_COPY.copyDiff}
        />
      </View>
      {hasBody && expanded ? (
        <DiffCardRows
          file={file}
          fontScale={fontScale}
          disclosureKey={disclosureKey}
          rootIdentity={rootIdentity}
        />
      ) : null}
    </View>
  )
}
