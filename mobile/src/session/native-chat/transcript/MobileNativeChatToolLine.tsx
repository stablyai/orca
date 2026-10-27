import { useMemo } from 'react'
import { Pressable, Text, View } from 'react-native'
import { MobileNativeChatOwnedScrollView } from '../../MobileNativeChatOwnedScrollView'
import { ChevronRight } from 'lucide-react-native'
import {
  diffFromText,
  diffFromToolCall
} from '../../../../../src/shared/native-chat/tools/native-chat-diff'
import type { NativeChatDiffLine } from '../../../../../src/shared/native-chat/tools/native-chat-diff'
import {
  formatToolDuration,
  mcpToolIdentity,
  type NativeChatWebSearchResult
} from '../../../../../src/shared/native-chat/tools/native-chat-tool-identity'
import { NATIVE_CHAT_TOOL_ACTIVITY_COPY } from '../../../../../src/shared/native-chat/tools/native-chat-tool-activity'
import { nativeChatToolIconName } from '../../../../../src/shared/native-chat/tools/native-chat-tool-icon'
import { NATIVE_CHAT_TOOL_ROW_VERB_COPY } from '../../../../../src/shared/native-chat/tools/native-chat-tool-line-label'
import { nativeChatToolLineView } from '../../../../../src/shared/native-chat/tools/native-chat-tool-line-view'
import type {
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../../../../src/shared/native-chat-types'
import { MobileSourceCopyButton } from '../../../components/MobileSourceCopyButton'
import { MobileSyntaxSegments } from '../../../components/MobileSyntaxSegments'
import { INLINE_TEXT_SELECTION } from '../../../components/inline-text-selection'
import { openExternalLink } from '../../../platform/external-link'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { highlightMobileCode } from '../../mobile-file-syntax'
import { MobileNativeChatToolGlyph } from './MobileNativeChatToolIcon'
import { MobileNativeChatToolOutput } from '../../MobileNativeChatFullContent'
import { useMobileNativeChatOpenedDetail } from '../visual/mobile-native-chat-opened-detail'
import { useMobileNativeChatDisclosure } from './mobile-native-chat-disclosure-store'
import { toolStyles as styles, toolType } from './mobile-native-chat-tool-styles'

function SearchResults({
  results,
  fontScale
}: {
  results: NativeChatWebSearchResult[]
  fontScale: number
}): React.JSX.Element {
  useMobileColorScheme()
  const type = toolType(fontScale).meta
  return (
    <View style={[styles.codeBox, styles.searchResults]}>
      {results.map((hit) => (
        <Text
          key={hit.url}
          style={[styles.codeText, styles.searchHit, type]}
          numberOfLines={1}
          onPress={() => openExternalLink(hit.url)}
          accessibilityRole="link"
        >
          {hit.title}
          {hit.title !== hit.url ? <Text style={styles.searchUrl}>{`  ${hit.url}`}</Text> : null}
        </Text>
      ))}
    </View>
  )
}

function DiffView({ lines, fontScale }: { lines: NativeChatDiffLine[]; fontScale: number }) {
  useMobileColorScheme()
  const type = toolType(fontScale).code
  return (
    <View style={styles.codeBox}>
      {lines.map((line, index) => (
        <Text
          key={index}
          style={[
            styles.codeText,
            type,
            line.kind === 'add' && styles.diffAdd,
            line.kind === 'del' && styles.diffDel,
            line.kind === 'meta' && styles.diffMeta
          ]}
        >
          {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
          {line.text}
        </Text>
      ))}
    </View>
  )
}

// Defer output diff/highlight work until its row opens.
function ToolLineDetail({
  call,
  body,
  fullCommand,
  commandLanguage,
  results,
  fontScale,
  disclosureKey,
  memberId
}: {
  call: NativeChatToolCallBlock | undefined
  body: NativeChatToolResultBlock | undefined
  fullCommand: string | null
  commandLanguage: string | null
  results: NativeChatWebSearchResult[]
  fontScale: number
  disclosureKey?: string
  memberId?: string
}): React.JSX.Element {
  useMobileColorScheme()
  const diff = call
    ? diffFromToolCall(call.name, call.input)
    : body
      ? diffFromText(body.output)
      : null
  const command = useMemo(
    () =>
      !diff && fullCommand && commandLanguage
        ? highlightMobileCode(fullCommand, commandLanguage).segments
        : null,
    [diff, fullCommand, commandLanguage]
  )
  const type = toolType(fontScale).code
  const onLayout = useMobileNativeChatOpenedDetail()
  return (
    <View style={styles.detail} onLayout={onLayout}>
      {results.length > 0 ? <SearchResults results={results} fontScale={fontScale} /> : null}
      {diff ? <DiffView lines={diff} fontScale={fontScale} /> : null}
      {!diff && fullCommand ? (
        <MobileNativeChatOwnedScrollView
          rootIdentity={`${memberId ?? call?.callId ?? 'detail'}:command`}
          positionKey={`${disclosureKey ?? call?.callId ?? 'detail'}:command`}
          style={[styles.codeBox, styles.codeScroll]}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
        >
          <Text selectable={INLINE_TEXT_SELECTION} style={[styles.codeText, type]}>
            {command ? <MobileSyntaxSegments segments={command} /> : fullCommand}
          </Text>
        </MobileNativeChatOwnedScrollView>
      ) : null}
      {body ? (
        <MobileNativeChatToolOutput
          body={body}
          type={type}
          rootIdentity={`${memberId ?? body.callId ?? 'detail'}:output`}
          positionKey={`${disclosureKey ?? body.callId ?? 'detail'}:output`}
        />
      ) : null}
    </View>
  )
}

export function MobileNativeChatToolLine({
  memberId,
  block,
  result,
  disclosureKey,
  fontScale,
  onOpenFile
}: {
  memberId?: string
  block: NativeChatToolCallBlock | NativeChatToolResultBlock
  result?: NativeChatToolResultBlock
  disclosureKey?: string
  fontScale: number
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  useMobileColorScheme()
  const [expanded, setExpanded] = useMobileNativeChatDisclosure(disclosureKey, false)
  const { call, label, body, resultPreview, failed, results, hasDetail } = useMemo(
    () => nativeChatToolLineView(block, result),
    [block, result]
  )
  const commandDetail = label?.commandDetail ?? null
  const fullCommand = label?.fullCommand ?? null
  const verb = label?.verb ? NATIVE_CHAT_TOOL_ROW_VERB_COPY[label.verb] : null
  const commandAlone = label?.command === true && verb !== null && label.target.length > 0
  const mcp = call ? mcpToolIdentity(call.name, call.mcpIdentity) : null
  const name = call
    ? mcp
      ? `${mcp.server} / ${mcp.tool}`
      : call.name
    : NATIVE_CHAT_TOOL_ACTIVITY_COPY.result
  const target = label ? label.target : resultPreview
  const filePath = label?.filePath ?? null
  const type = toolType(fontScale)
  const iconSize = 15 * fontScale
  const exitCode = call && Number.isSafeInteger(call.exitCode) ? call.exitCode : undefined
  const duration = call ? formatToolDuration(call.durationMs) : null

  return (
    <View testID={memberId}>
      <View style={styles.line}>
        <Pressable
          style={[styles.line, styles.cardToggle]}
          onPress={() => hasDetail && setExpanded(!expanded)}
          disabled={!hasDetail}
          accessibilityRole="button"
          accessibilityState={hasDetail ? { expanded } : undefined}
        >
          <View style={[styles.iconSlot, { width: iconSize }]}>
            {call ? (
              <MobileNativeChatToolGlyph
                name={nativeChatToolIconName(call.name, call.mcpIdentity, call.input)}
                size={iconSize}
                color={failed ? colors.statusRed : colors.textMuted}
              />
            ) : null}
          </View>
          {commandAlone ? null : (
            <Text style={[styles.lineWord, type.row, !verb && styles.lineName]} numberOfLines={1}>
              {verb ?? name}
            </Text>
          )}
          {target ? (
            <Text
              style={[styles.lineTarget, type.row, filePath && onOpenFile && styles.lineLink]}
              numberOfLines={1}
              onPress={filePath && onOpenFile ? () => onOpenFile(filePath) : undefined}
              suppressHighlighting={!(filePath && onOpenFile)}
              accessibilityRole={filePath && onOpenFile ? 'link' : undefined}
            >
              {target}
            </Text>
          ) : null}
          {/* Held at the row's right edge, so the carets of a run line up in one column. */}
          <View style={styles.lineTrailing}>
            {exitCode !== undefined ? (
              <Text style={[styles.lineMeta, type.meta, exitCode !== 0 && styles.errorText]}>
                {`exit ${exitCode}`}
              </Text>
            ) : null}
            {duration ? <Text style={[styles.lineMeta, type.meta]}>{duration}</Text> : null}
            {hasDetail ? (
              <View style={expanded ? styles.caretOpen : undefined}>
                <ChevronRight size={14 * fontScale} color={colors.textMuted} strokeWidth={2} />
              </View>
            ) : null}
          </View>
        </Pressable>
        {fullCommand ? (
          <MobileSourceCopyButton text={fullCommand} accessibilityLabel="Copy command" />
        ) : null}
      </View>
      {hasDetail && expanded ? (
        <ToolLineDetail
          memberId={memberId}
          disclosureKey={disclosureKey}
          call={call}
          body={body}
          fullCommand={commandDetail}
          commandLanguage={label?.commandLanguage ?? null}
          results={results}
          fontScale={fontScale}
        />
      ) : null}
    </View>
  )
}
