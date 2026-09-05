import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, Text, View } from 'react-native'
import { ChevronDown, SquareChevronRight, SquareTerminal, Wrench } from 'lucide-react-native'
import { diffFromText, diffFromToolCall } from '../../../src/shared/native-chat-diff'
import type { NativeChatDiffLine as DiffLine } from '../../../src/shared/native-chat-diff'
import { pairToolBlocks } from '../../../src/shared/native-chat-tool-fold'
import type { NativeChatToolPair as ToolPair } from '../../../src/shared/native-chat-tool-fold'
import {
  createToolInputDisplay,
  summarizeToolRun,
  truncateToolDetail
} from '../../../src/shared/native-chat-tool-summary'
import {
  describeActiveToolCall,
  formatActiveToolLabel,
  formatToolCallCount,
  isCommandToolName,
  selectActiveToolCall
} from '../../../src/shared/native-chat-tool-activity'
import type { NativeChatBlock } from '../../../src/shared/native-chat-types'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-message-styles'

const MAX_VISIBLE_TOOL_PAIRS = 6
const MAX_TOOL_RUN_DIFF_ROWS = 240

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
      <Text style={styles.mono}>{truncateToolDetail(output)}</Text>
    </View>
  )
}

/** One request: a tool call and its result rendered together as a single
 *  expandable line. `defaultExpanded` lets the group toggle open every line. */
function ToolLine({
  pair,
  defaultExpanded,
  diffLineLimit,
  onOpenFile
}: {
  pair: ToolPair
  defaultExpanded: boolean
  diffLineLimit: number
  onOpenFile?: (relativePath: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const { call, result } = pair
  const name = call ? call.name : 'Result'
  const inputDisplay = call ? createToolInputDisplay(call.input) : null
  const preview = inputDisplay?.label ?? result?.output.split('\n')[0]?.slice(0, 80) ?? ''
  // Why: collapsed tool rows are the common path; defer bounded diff parsing
  // and detail formatting until the user asks to reveal the detail.
  const callDiff = expanded && call ? diffFromToolCall(call.name, call.input, diffLineLimit) : null
  const resultDiff = expanded && result ? diffFromText(result.output, diffLineLimit) : null
  const callDetail = expanded && inputDisplay && !callDiff ? inputDisplay.formatDetail() : undefined
  const hasDetail = callDiff !== null || result !== undefined || inputDisplay?.hasDetail === true
  // The group toggle opens every line at once, bypassing the tap guard, so the
  // panel has to consult it too — else a detail-less row echoes its own label
  // under itself and no tap can dismiss it.
  const showDetail = hasDetail && expanded
  // A tool that targets a file (Read/Edit/Write…) renders its preview as a
  // tappable link that opens the file, independent of the line's expand tap.
  const filePath = inputDisplay?.filePath ?? null
  const openable = filePath !== null && onOpenFile !== undefined
  return (
    <View>
      <Pressable
        style={styles.toolLine}
        onPress={() => hasDetail && setExpanded((v) => !v)}
        hitSlop={6}
      >
        {showDetail ? (
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
      {showDetail ? (
        <View style={styles.toolDetail}>
          {callDiff ? <DiffView lines={callDiff} /> : null}
          {callDetail ? <Text style={styles.mono}>{callDetail}</Text> : null}
          {result ? (
            <ResultBody output={result.output} isError={result.isError} diff={resultDiff} />
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

/** Breathing label for a still-running tool, matching desktop's `animate-pulse`. */
function PulsingText({
  style,
  numberOfLines,
  children
}: {
  style?: React.ComponentProps<typeof Animated.Text>['style']
  numberOfLines?: number
  children: React.ReactNode
}): React.JSX.Element {
  const pulse = useRef(new Animated.Value(1)).current
  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true })
      ])
    )
    animation.start()
    return () => animation.stop()
  }, [pulse])
  return (
    <Animated.Text style={[style, { opacity: pulse }]} numberOfLines={numberOfLines}>
      {children}
    </Animated.Text>
  )
}

/** A run of a message's tool calls/results, collapsed to a one-line summary that
 *  expands to the individual inline tool lines. `defaultExpanded` lets the global
 *  toolbar toggle drive every run at once while still allowing per-run override. */
export function ToolRun({
  blocks,
  defaultExpanded,
  expandChildren,
  activeCall,
  trailing,
  onOpenFile
}: {
  blocks: NativeChatBlock[]
  defaultExpanded: boolean
  /** Child tool lines stay collapsed when the turn caret drove the run open. */
  expandChildren: boolean
  /** The still-running call, when the turn is live (desktop parity). */
  activeCall: ReturnType<typeof selectActiveToolCall>
  trailing?: React.ReactNode
  onOpenFile?: (relativePath: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultExpanded)
  const pairs = pairToolBlocks(blocks, MAX_VISIBLE_TOOL_PAIRS)
  const diffLineLimit = Math.max(1, Math.floor(MAX_TOOL_RUN_DIFF_ROWS / (pairs.length * 2 || 1)))
  let callCount = 0
  for (const block of blocks) {
    if (block.type === 'tool-call') {
      callCount++
    }
  }
  callCount ||= pairs.length
  const summary = summarizeToolRun(blocks)
  const ActiveToolIcon = activeCall && isCommandToolName(activeCall.name) ? SquareTerminal : Wrench
  return (
    <View style={styles.toolRun}>
      <View style={styles.toolRunHeader}>
        {activeCall ? (
          <Pressable
            style={styles.toolRunActive}
            onPress={() => setOpen((v) => !v)}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLiveRegion="polite"
          >
            <ActiveToolIcon size={15} color={colors.textMuted} strokeWidth={2} />
            <PulsingText style={styles.toolRunActiveLabel} numberOfLines={1}>
              {formatActiveToolLabel(describeActiveToolCall(activeCall))}
            </PulsingText>
            {open ? <ChevronDown size={15} color={colors.textMuted} strokeWidth={2} /> : null}
          </Pressable>
        ) : (
          <Pressable style={styles.toolRunToggle} onPress={() => setOpen((v) => !v)} hitSlop={6}>
            {open ? (
              <ChevronDown size={15} color={colors.textMuted} strokeWidth={2} />
            ) : (
              <SquareChevronRight size={15} color={colors.textMuted} strokeWidth={2} />
            )}
            <Text style={styles.toolRunCount}>{callCount}×</Text>
            <Text style={styles.toolRunLabel} numberOfLines={1}>
              {summary || formatToolCallCount(callCount)}
            </Text>
          </Pressable>
        )}
        {trailing}
      </View>
      {open ? (
        <View style={styles.toolRunBody}>
          {pairs.map((pair, i) => (
            <ToolLine
              key={i}
              pair={pair}
              defaultExpanded={expandChildren}
              diffLineLimit={diffLineLimit}
              onOpenFile={onOpenFile}
            />
          ))}
          {callCount > pairs.length ? (
            <Text style={styles.toolPreview}>… {callCount - pairs.length} more tool calls</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}
