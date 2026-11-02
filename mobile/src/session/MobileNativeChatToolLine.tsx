import { useMemo } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { agentJournalToolCallLifecycle } from '../../../src/shared/agent-journal-tool-call-lifecycle'
import { diffFromText, diffFromToolCall } from '../../../src/shared/native-chat-diff'
import type { NativeChatDiffLine } from '../../../src/shared/native-chat-diff'
import {
  formatToolDuration,
  mcpToolIdentity,
  toolWebSearchResults,
  type NativeChatWebSearchResult
} from '../../../src/shared/native-chat-tool-identity'
import { nativeChatToolIconName } from '../../../src/shared/native-chat-tool-icon'
import {
  NATIVE_CHAT_TOOL_ROW_VERB_COPY,
  nativeChatToolLineLabel
} from '../../../src/shared/native-chat-tool-line-label'
import { truncateToolDetail } from '../../../src/shared/native-chat-tool-summary'
import {
  isToolCallBlock,
  type NativeChatToolCallBlock,
  type NativeChatToolResultBlock
} from '../../../src/shared/native-chat-types'
import { MobileSyntaxSegments } from '../components/MobileSyntaxSegments'
import { INLINE_TEXT_SELECTION } from '../components/inline-text-selection'
import { openExternalLink } from '../platform/external-link'
import { colors } from '../theme/mobile-theme'
import { highlightMobileCode } from './mobile-file-syntax'
import { MobileNativeChatToolGlyph } from './MobileNativeChatToolIcon'
import { useMobileNativeChatOpenedDetail } from './mobile-native-chat-opened-detail'
import { useMobileNativeChatDisclosure } from './mobile-native-chat-disclosure-store'
import { toolStyles as styles, toolType } from './mobile-native-chat-tool-styles'

const RESULT_LABEL = 'Result'
const NO_SEARCH_RESULTS: NativeChatWebSearchResult[] = []

/** Desktop parity: `NativeChatSearchResults`. The search's hits as links. */
function SearchResults({
  results,
  fontScale
}: {
  results: NativeChatWebSearchResult[]
  fontScale: number
}): React.JSX.Element {
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

/** Desktop parity: `NativeChatToolLine`'s `ToolLineDetail`. Its own component so a
 *  row diffs and highlights only while it is open. */
function ToolLineDetail({
  call,
  body,
  fullCommand,
  commandLanguage,
  results,
  fontScale
}: {
  call: NativeChatToolCallBlock | undefined
  body: NativeChatToolResultBlock | undefined
  fullCommand: string | null
  commandLanguage: string | null
  results: NativeChatWebSearchResult[]
  fontScale: number
}): React.JSX.Element {
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
        <ScrollView
          style={[styles.codeBox, styles.codeScroll]}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
        >
          <Text selectable={INLINE_TEXT_SELECTION} style={[styles.codeText, type]}>
            {command ? <MobileSyntaxSegments segments={command} /> : fullCommand}
          </Text>
        </ScrollView>
      ) : null}
      {body ? (
        <ScrollView
          style={[styles.codeBox, styles.codeScroll]}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
        >
          <Text
            selectable={INLINE_TEXT_SELECTION}
            style={[styles.codeText, type, body.isError && styles.errorText]}
          >
            {truncateToolDetail(body.output)}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  )
}

/** Desktop parity: `NativeChatToolLine`. A tool sentence with its output behind its
 *  own disclosure; an orphan result draws as a `Result` row. */
export function MobileNativeChatToolLine({
  block,
  result,
  defaultExpanded,
  disclosureKey,
  fontScale,
  onOpenFile
}: {
  block: NativeChatToolCallBlock | NativeChatToolResultBlock
  /** This call's output, when the run paired one to it. */
  result?: NativeChatToolResultBlock
  defaultExpanded: boolean
  /** Identity this line's open state is remembered under while it is unmounted. */
  disclosureKey?: string
  fontScale: number
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useMobileNativeChatDisclosure(disclosureKey, defaultExpanded)
  const call = isToolCallBlock(block) ? block : undefined
  const label = call ? nativeChatToolLineLabel(call, result) : null
  const body = call ? result : block.type === 'tool-result' ? block : undefined
  const fullCommand = label?.commandDetail ?? null
  // A call the reader stopped was cut short, not failed.
  const lifecycle = call ? agentJournalToolCallLifecycle(call) : null
  const failed = lifecycle === 'failed' || (lifecycle !== 'interrupted' && result?.isError === true)
  const verb = label?.verb ? NATIVE_CHAT_TOOL_ROW_VERB_COPY[label.verb] : null
  // The run's header already says these ran; the row is the command itself.
  const commandAlone = label?.command === true && verb !== null && label.target.length > 0
  const mcp = call ? mcpToolIdentity(call.name, call.mcpIdentity) : null
  const name = call ? (mcp ? `${mcp.server} / ${mcp.tool}` : call.name) : RESULT_LABEL
  const target = label ? label.target : (body?.output.split('\n')[0]?.slice(0, 80) ?? '')
  const results = useMemo(
    () => (call ? toolWebSearchResults(call.webSearchResults) : NO_SEARCH_RESULTS),
    [call]
  )
  // An edit that has not landed has no output yet, but the change it proposes is worth opening.
  const hasDetail =
    body !== undefined ||
    fullCommand !== null ||
    results.length > 0 ||
    (call !== undefined && diffFromToolCall(call.name, call.input) !== null)
  const filePath = label?.filePath ?? null
  const type = toolType(fontScale)
  const iconSize = 15 * fontScale
  const exitCode = call && Number.isSafeInteger(call.exitCode) ? call.exitCode : undefined
  const duration = call ? formatToolDuration(call.durationMs) : null

  return (
    <View>
      <Pressable
        style={styles.line}
        onPress={() => hasDetail && setExpanded(!expanded)}
        disabled={!hasDetail}
        accessibilityRole="button"
        accessibilityState={hasDetail ? { expanded } : undefined}
      >
        <View style={[styles.iconSlot, { width: iconSize }]}>
          {call ? (
            <MobileNativeChatToolGlyph
              name={nativeChatToolIconName(call.name, call.mcpIdentity)}
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
      {hasDetail && expanded ? (
        <ToolLineDetail
          call={call}
          body={body}
          fullCommand={fullCommand}
          commandLanguage={label?.commandLanguage ?? null}
          results={results}
          fontScale={fontScale}
        />
      ) : null}
    </View>
  )
}
