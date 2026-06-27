import { memo, useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { ArrowUp, ChevronDown, Copy, SquareChevronRight } from 'lucide-react-native'
import type { NativeChatBlock, NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { colors } from '../theme/mobile-theme'
import {
  isImageRefBlock,
  isTextBlock,
  pairToolBlocks,
  splitNativeChatBlocks,
  type ToolPair
} from './mobile-native-chat-blocks'
import { diffFromText, diffFromToolCall, type DiffLine } from './mobile-native-chat-diff'
import { MAX_TOOL_RESULT_CHARS, styles, TEXT_SIZE } from './mobile-native-chat-message-styles'
import { nativeChatMessageText } from './mobile-native-chat-message-text'
import {
  summarizeToolInput,
  summarizeToolRun,
  toolFilePath
} from './mobile-native-chat-tool-summary'

function DiffView({ lines }: { lines: DiffLine[] }): React.JSX.Element {
  return (
    <View style={styles.diff}>
      {lines.map((line, i) => (
        <Text
          key={i}
          style={[
            styles.diffLine,
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

/** A single inline tool line — `▸ ToolName  preview` — that expands in place to
 *  show the call's diff/input or the result's body. Mirrors the reference design
 *  where tool calls read as flat lines in the conversation, not boxed blocks. */
function ResultBody({
  output,
  isError,
  diff
}: {
  output: string
  isError?: boolean
  diff: DiffLine[] | null
}): React.JSX.Element {
  if (diff) {
    return <DiffView lines={diff} />
  }
  return (
    <View style={[styles.toolResult, isError && styles.toolResultError]}>
      <Text style={styles.mono}>
        {output.length > MAX_TOOL_RESULT_CHARS
          ? `${output.slice(0, MAX_TOOL_RESULT_CHARS)}…`
          : output}
      </Text>
    </View>
  )
}

/** One request: a tool call and its result rendered together as a single
 *  expandable line. `defaultExpanded` lets the group toggle open every line. */
function ToolLine({
  pair,
  defaultExpanded,
  onOpenFile
}: {
  pair: ToolPair
  defaultExpanded: boolean
  onOpenFile?: (relativePath: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded)
  useEffect(() => setExpanded(defaultExpanded), [defaultExpanded])
  const { call, result } = pair
  const name = call ? call.name : 'Result'
  const preview = call
    ? summarizeToolInput(call.input)
    : (result?.output.split('\n')[0]?.slice(0, 80) ?? '')
  const callDiff = call ? diffFromToolCall(call.name, call.input) : null
  const resultDiff = result ? diffFromText(result.output) : null
  const hasDetail = callDiff !== null || result !== undefined || preview.length > 40
  // A tool that targets a file (Read/Edit/Write…) renders its preview as a
  // tappable link that opens the file, independent of the line's expand tap.
  const filePath = call ? toolFilePath(call.input) : null
  const openable = filePath !== null && onOpenFile !== undefined
  return (
    <View>
      <Pressable
        style={styles.toolLine}
        onPress={() => hasDetail && setExpanded((v) => !v)}
        hitSlop={6}
      >
        {expanded ? (
          <ChevronDown size={15} color={colors.textMuted} strokeWidth={2} />
        ) : (
          <SquareChevronRight size={15} color={colors.textMuted} strokeWidth={2} />
        )}
        <Text style={styles.toolName}>{name}</Text>
        {preview ? (
          <Text
            style={[styles.toolPreview, openable && styles.toolPreviewLink]}
            numberOfLines={1}
            onPress={openable ? () => onOpenFile!(filePath!) : undefined}
            suppressHighlighting={!openable}
          >
            {preview}
          </Text>
        ) : null}
      </Pressable>
      {expanded ? (
        <View style={styles.toolDetail}>
          {callDiff ? <DiffView lines={callDiff} /> : null}
          {!callDiff && call && preview ? <Text style={styles.mono}>{preview}</Text> : null}
          {result ? (
            <ResultBody output={result.output} isError={result.isError} diff={resultDiff} />
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

function Prose({
  block,
  invert,
  fontScale,
  onOpenFile
}: {
  block: NativeChatBlock
  invert?: boolean
  fontScale: number
  onOpenFile?: (relativePath: string) => void
}): React.JSX.Element | null {
  if (isTextBlock(block)) {
    // Inverted (user) bubbles use a fixed dark-on-light text rather than the
    // markdown renderer's light-on-dark palette.
    if (invert) {
      return (
        <Text style={[styles.userText, { fontSize: TEXT_SIZE * fontScale }]}>{block.text}</Text>
      )
    }
    return (
      <MobileMarkdown content={block.text} textScale={1.25 * fontScale} onOpenFile={onOpenFile} />
    )
  }
  if (isImageRefBlock(block)) {
    return (
      <Text style={[styles.imageRef, { fontSize: TEXT_SIZE * fontScale }]}>
        🖼 {block.alt ?? block.path ?? block.url ?? 'image'}
      </Text>
    )
  }
  return null
}

/** A run of a message's tool calls/results, collapsed to a one-line summary that
 *  expands to the individual inline tool lines. `defaultExpanded` lets the global
 *  toolbar toggle drive every run at once while still allowing per-run override. */
function ToolRun({
  blocks,
  defaultExpanded,
  trailing,
  onOpenFile
}: {
  blocks: NativeChatBlock[]
  defaultExpanded: boolean
  trailing?: React.ReactNode
  onOpenFile?: (relativePath: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultExpanded)
  // Re-sync when the global toolbar toggle flips.
  useEffect(() => setOpen(defaultExpanded), [defaultExpanded])
  const pairs = pairToolBlocks(blocks)
  const callCount = blocks.filter((b) => b.type === 'tool-call').length || pairs.length
  const summary = summarizeToolRun(blocks)
  return (
    <View style={styles.toolRun}>
      <View style={styles.toolRunHeader}>
        <Pressable style={styles.toolRunToggle} onPress={() => setOpen((v) => !v)} hitSlop={6}>
          {open ? (
            <ChevronDown size={15} color={colors.textMuted} strokeWidth={2} />
          ) : (
            <SquareChevronRight size={15} color={colors.textMuted} strokeWidth={2} />
          )}
          <Text style={styles.toolRunCount}>{callCount}×</Text>
          <Text style={styles.toolRunLabel} numberOfLines={1}>
            {summary || `${callCount} tool ${callCount === 1 ? 'call' : 'calls'}`}
          </Text>
        </Pressable>
        {trailing}
      </View>
      {open ? (
        <View style={styles.toolRunBody}>
          {pairs.map((pair, i) => (
            <ToolLine
              key={i}
              pair={pair}
              defaultExpanded={defaultExpanded}
              onOpenFile={onOpenFile}
            />
          ))}
        </View>
      ) : null}
    </View>
  )
}

/** Subtle top-right controls for an agent message: copy its prose, or scroll so
 *  this message's top aligns to the top of the viewport. */
function AgentControls({
  onCopy,
  onScrollToTop
}: {
  onCopy: () => void
  onScrollToTop?: () => void
}): React.JSX.Element {
  return (
    <View style={styles.controls}>
      <Pressable
        style={({ pressed }) => [styles.controlButton, pressed && styles.controlPressed]}
        onPress={onCopy}
        hitSlop={8}
        accessibilityLabel="Copy message"
      >
        <Copy size={14} color={colors.textMuted} strokeWidth={2} />
      </Pressable>
      {onScrollToTop ? (
        <Pressable
          style={({ pressed }) => [styles.controlButton, pressed && styles.controlPressed]}
          onPress={onScrollToTop}
          hitSlop={8}
          accessibilityLabel="Scroll this message to top"
        >
          <ArrowUp size={14} color={colors.textMuted} strokeWidth={2} />
        </Pressable>
      ) : null}
    </View>
  )
}

// Delay the "Queued" affordance so a fast local turn doesn't flash it before its
// real turn lands in the transcript. Mirrors desktop NativeChatMessageList.
const QUEUED_AFFORDANCE_DELAY_MS = 500

function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!active) {
      setShown(false)
      return
    }
    const timer = setTimeout(() => setShown(true), delayMs)
    return () => clearTimeout(timer)
  }, [active, delayMs])
  return shown
}

function MobileNativeChatMessageImpl({
  message,
  queued,
  toolsExpanded = false,
  fontScale = 1,
  messageIndex,
  onScrollToMessage,
  onOpenFile
}: {
  message: NativeChatMessage
  queued?: boolean
  toolsExpanded?: boolean
  /** Multiplies all chat text sizes for pinch-to-zoom (1 = no change). */
  fontScale?: number
  /** This message's index in the list, paired with onScrollToMessage. */
  messageIndex?: number
  /** Ask the list to align this message's top to the top of the viewport. */
  onScrollToMessage?: (index: number) => void
  onOpenFile?: (relativePath: string) => void
}): React.JSX.Element | null {
  const isUser = message.role === 'user'
  const isReasoning = message.role === 'reasoning'
  const isAgent = !isUser
  // Briefly tint the bubble to confirm a copy landed.
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copyTimer.current) {
        clearTimeout(copyTimer.current)
      }
    },
    []
  )
  // Show the "Queued" affordance only after a brief delay (no flash on fast sends).
  const showQueued = useDelayedFlag(queued ?? false, QUEUED_AFFORDANCE_DELAY_MS)
  // Separate the agent's words from its tool activity: prose renders first, the
  // tool calls fold into a collapsible run beneath. The user's own messages get
  // an inverted (filled accent) bubble so they stand apart from agent prose.
  const { prose, tools } = splitNativeChatBlocks(message.blocks)
  // Skip a genuinely empty turn so the transcript shows no empty bubble. (Unlike
  // desktop, mobile renders image-ref blocks, so an image-only turn is content.)
  if (prose.length === 0 && tools.length === 0) {
    return null
  }

  const handleCopy = (): void => {
    const text = nativeChatMessageText(message.blocks)
    if (!text) {
      return
    }
    void Clipboard.setStringAsync(text)
    setCopied(true)
    if (copyTimer.current) {
      clearTimeout(copyTimer.current)
    }
    copyTimer.current = setTimeout(() => setCopied(false), 700)
  }

  // Copy + scroll-to-top, shown inline with the first tool call (or after the
  // prose when there are no tools).
  const controls =
    isAgent && !queued ? (
      <AgentControls
        onCopy={handleCopy}
        onScrollToTop={
          onScrollToMessage && messageIndex !== undefined
            ? () => onScrollToMessage(messageIndex)
            : undefined
        }
      />
    ) : null

  return (
    <View style={[styles.row, isUser && styles.rowUser]}>
      {isUser && showQueued ? <Text style={styles.queuedTag}>Queued</Text> : null}
      <View
        style={[
          styles.content,
          isUser && styles.userBubble,
          isReasoning && styles.reasoning,
          showQueued && styles.queued,
          copied && styles.copied
        ]}
      >
        {prose.map((block, index) => (
          <Prose
            key={index}
            block={block}
            invert={isUser}
            fontScale={fontScale}
            onOpenFile={onOpenFile}
          />
        ))}
        {tools.length > 0 ? (
          <ToolRun
            blocks={tools}
            defaultExpanded={toolsExpanded}
            trailing={controls}
            onOpenFile={onOpenFile}
          />
        ) : controls ? (
          <View style={styles.controlsRow}>{controls}</View>
        ) : null}
      </View>
    </View>
  )
}

export const MobileNativeChatMessage = memo(MobileNativeChatMessageImpl)
