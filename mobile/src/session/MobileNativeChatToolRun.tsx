import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Animated,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native'
import { Check } from 'lucide-react-native'
import {
  describeLatestToolCall,
  NATIVE_CHAT_TOOL_ACTIVITY_COPY,
  selectActiveToolCall
} from '../../../src/shared/native-chat-tool-activity'
import { nativeChatToolRunIconName } from '../../../src/shared/native-chat-tool-icon'
import { nativeChatToolLineIdentity } from '../../../src/shared/native-chat-tool-line-identity'
import { pairNativeChatToolResults } from '../../../src/shared/native-chat-tool-pairing'
import { nativeChatToolRunOutcome } from '../../../src/shared/native-chat-tool-run-outcome'
import {
  NATIVE_CHAT_TOOL_RUN_SENTENCE_ENGLISH,
  nativeChatToolRunSentence
} from '../../../src/shared/native-chat-tool-run-sentence'
import { countToolCalls } from '../../../src/shared/native-chat-tool-summary'
import { buildEditCards } from '../../../src/shared/native-chat-edit-cards'
import {
  isToolCallBlock,
  type NativeChatBlock,
  type NativeChatToolCallBlock
} from '../../../src/shared/native-chat-types'
import { buildNativeChatTaskListRows } from '../../../src/shared/native-chat-task-list-history'
import { colors } from '../theme/mobile-theme'
import { MobileNativeChatToolGlyph } from './MobileNativeChatToolIcon'
import { MobileNativeChatToolLine } from './MobileNativeChatToolLine'
import { MobileNativeChatDiffCard } from './MobileNativeChatDiffCard'
import { MobileNativeChatTaskList } from './MobileNativeChatTaskList'
import { MobileNativeChatOpenedDetailContext } from './mobile-native-chat-opened-detail'
import {
  MAX_DISCLOSURES,
  MobileNativeChatDisclosureContext,
  useMobileNativeChatDisclosure
} from './mobile-native-chat-disclosure-store'
import { toolStyles as styles, toolType } from './mobile-native-chat-tool-styles'

/** Desktop's 18rem: an opened run lists this much before it scrolls in place. */
const MEMBERS_MIN_HEIGHT = 288
/** Desktop's `NATIVE_CHAT_FOLLOW_REARM_PX`: this close to the end, the box follows new work. */
const FOLLOW_REARM_PX = 24

function fill(template: string, value: number): string {
  return template.replaceAll('{{value0}}', String(value))
}

/** Desktop's `animate-pulse` on a live run's sentence. One element either way, so the
 *  header never remounts as the run settles. */
function PulsingText({
  pulsing,
  style,
  children
}: {
  pulsing: boolean
  style?: React.ComponentProps<typeof Animated.Text>['style']
  children: React.ReactNode
}): React.JSX.Element {
  const opacity = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (!pulsing) {
      opacity.setValue(1)
      return
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.5, duration: 1000, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 1000, useNativeDriver: true })
      ])
    )
    animation.start()
    return () => animation.stop()
  }, [opacity, pulsing])
  return (
    <Animated.Text style={[style, { opacity }]} numberOfLines={2}>
      {children}
    </Animated.Text>
  )
}

/** Desktop parity: `NativeChatToolRunAsides`. Rows drawn among an open run's lines, each keyed:
 *  before the block they are keyed by, or after the last. */
export type MobileNativeChatToolRunAsides = {
  before: ReadonlyMap<NativeChatBlock, readonly React.JSX.Element[]>
  after: readonly React.JSX.Element[]
}

/** Desktop parity: `NativeChatToolRunMembers`. An opened run's members in a bounded
 *  box, so live work fills it instead of lengthening the chat. A live run opens on
 *  what it is doing now and follows it while the reader stays at the end. */
function ToolRunMembers({
  followKey,
  startsAtEnd,
  memoryKey,
  children
}: {
  /** How much work the run holds: a reader at the end follows it growing. Opening a detail
   *  must not count. */
  followKey: number
  startsAtEnd: boolean
  /** The run's disclosure key. The list recycles rows; the box comes back as the reader left it. */
  memoryKey?: string
  children: React.ReactNode
}): React.JSX.Element {
  const { height } = useWindowDimensions()
  const runScroll = useContext(MobileNativeChatDisclosureContext)?.runScroll
  const [remembered] = useState(() =>
    memoryKey === undefined ? undefined : runScroll?.get(memoryKey)
  )
  const scroller = useRef<ScrollView>(null)
  const followsEnd = useRef(remembered?.followsEnd ?? startsAtEnd)
  const pendingRestore = useRef(remembered !== undefined && !remembered.followsEnd)
  // Desktop's rule: follow when the work changes, and only if the reader was at the end before
  // it. Resolved here, with the update, so a later detail opening never inherits a follow.
  useLayoutEffect(() => {
    if (followsEnd.current) {
      scroller.current?.scrollToEnd({ animated: false })
    }
  }, [followKey])
  const details = useRef(new Map<string, number>())
  const [openedHeight, setOpenedHeight] = useState(0)
  // Room for the list plus what the reader has opened in it, up to half the screen.
  const reportDetail = useCallback((detailId: string, detailHeight: number | null) => {
    if (detailHeight === null) {
      details.current.delete(detailId)
    } else {
      details.current.set(detailId, detailHeight)
    }
    let total = 0
    for (const value of details.current.values()) {
      total += value
    }
    setOpenedHeight(total)
  }, [])
  const onScroll = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = nativeEvent
    followsEnd.current =
      contentSize.height - contentOffset.y - layoutMeasurement.height <= FOLLOW_REARM_PX
    if (runScroll && memoryKey !== undefined) {
      runScroll.delete(memoryKey)
      runScroll.set(memoryKey, { top: contentOffset.y, followsEnd: followsEnd.current })
      if (runScroll.size > MAX_DISCLOSURES) {
        const oldest = runScroll.keys().next().value
        if (oldest !== undefined) {
          runScroll.delete(oldest)
        }
      }
    }
  }
  // The remembered offset needs the rows laid out first, which the box's first size reports.
  const onContentSizeChange = () => {
    if (pendingRestore.current && remembered) {
      pendingRestore.current = false
      scroller.current?.scrollTo({ y: remembered.top, animated: false })
    }
  }
  return (
    <MobileNativeChatOpenedDetailContext.Provider value={reportDetail}>
      <ScrollView
        ref={scroller}
        style={[
          styles.members,
          { maxHeight: Math.min(height / 2, MEMBERS_MIN_HEIGHT + openedHeight) }
        ]}
        nestedScrollEnabled
        // As the transcript's own list: a row or file tap lands while the composer's keyboard is up.
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={32}
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
      >
        {children}
      </ScrollView>
    </MobileNativeChatOpenedDetailContext.Provider>
  )
}

/** Desktop parity: `NativeChatToolRun`. A run of tool calls under one sentence that
 *  opens to the individual tool lines. */
export function ToolRun({
  blocks,
  defaultExpanded,
  expandChildren,
  disclosureId,
  asides,
  activeTurnIsWorking,
  trailing,
  awaitingAnswer = false,
  previousTodoWrite,
  previousUpdatePlan,
  fontScale = 1,
  onOpenFile
}: {
  blocks: NativeChatBlock[]
  /** The last plan each task-list tool wrote before this run, so an update reads as its changes. */
  previousTodoWrite?: NativeChatToolCallBlock
  previousUpdatePlan?: NativeChatToolCallBlock
  defaultExpanded: boolean
  /** The row this run belongs to. The list recycles rows, so what the reader opened is
   *  remembered somewhere that outlives the row. */
  disclosureId?: string
  /** Rows drawn among the run's lines, each before the block it is keyed by, or after the last. */
  asides?: MobileNativeChatToolRunAsides
  /** Every line's default: open under the Tools toggle. */
  expandChildren: boolean
  /** Structured lifecycle state; keeps an orphaned running call from spinning. */
  activeTurnIsWorking?: boolean
  /** Whether this run is the working turn's last. Only that run is live. */
  trailing?: boolean
  /** The turn is blocked on the reader's answer, so its calls decide liveness. */
  awaitingAnswer?: boolean
  fontScale?: number
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  // A reader's choice belongs to the default it deviated from, so toggling the Tools
  // default back restores it.
  const runKey = disclosureId === undefined ? undefined : `run:${disclosureId}:${defaultExpanded}`
  const [open, setOpen] = useMobileNativeChatDisclosure(runKey, defaultExpanded)
  // Rows drawn among the calls count as work too: a reader at the end follows them arriving.
  const asideCount = asides
    ? asides.after.length +
      Array.from(asides.before.values()).reduce((count, rows) => count + rows.length, 0)
    : 0
  // Live is the turn's state, not a call's: deriving it from "some call is running"
  // flipped the header to settled and back around every call.
  const live =
    activeTurnIsWorking === true && !awaitingAnswer
      ? trailing !== false
      : selectActiveToolCall(blocks, { activeTurnIsWorking }) !== null
  const callCount = countToolCalls(blocks)
  const sentence = nativeChatToolRunSentence(
    blocks,
    { live },
    NATIVE_CHAT_TOOL_RUN_SENTENCE_ENGLISH
  )
  const latestCall = live ? blocks.findLast(isToolCallBlock) : undefined
  const latestCallLabel = latestCall ? describeLatestToolCall(latestCall) : null
  const outcome = nativeChatToolRunOutcome(blocks, { activeTurnIsWorking })
  const headerIcon = nativeChatToolRunIconName(blocks.filter(isToolCallBlock))
  const fallbackLabel =
    callCount === 0
      ? 'Result'
      : callCount === 1
        ? NATIVE_CHAT_TOOL_ACTIVITY_COPY.countOne
        : fill(NATIVE_CHAT_TOOL_ACTIVITY_COPY.countN, callCount)
  const marks = [
    outcome.failedCallCount > 0
      ? fill(NATIVE_CHAT_TOOL_ACTIVITY_COPY.failedCount, outcome.failedCallCount)
      : null,
    outcome.interruptedCallCount > 0
      ? fill(NATIVE_CHAT_TOOL_ACTIVITY_COPY.interruptedCount, outcome.interruptedCallCount)
      : null
  ].filter((mark) => mark !== null)
  const type = toolType(fontScale)
  const iconSize = 15 * fontScale

  return (
    <View style={styles.run}>
      {/* One element for the run's whole life: live and settled are states of this
          button, not two buttons. */}
      <Pressable
        style={styles.header}
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLiveRegion="polite"
      >
        {headerIcon ? (
          <MobileNativeChatToolGlyph name={headerIcon} size={iconSize} color={colors.textMuted} />
        ) : null}
        <PulsingText
          pulsing={live}
          style={[styles.headerSentence, type.row, live && styles.headerSentenceLive]}
        >
          {sentence ?? fallbackLabel}
        </PulsingText>
        {marks.length > 0 ? (
          // Never shrinks: it is the one thing the reader cannot afford to miss.
          <Text style={[styles.lineMeta, styles.headerMarks, type.meta]} numberOfLines={1}>
            {` · ${marks.join(', ')}`}
          </Text>
        ) : null}
        {/* Only a stated success is marked done, and never while live. */}
        {!live && outcome.succeeded ? (
          <Check size={12 * fontScale} color={colors.textMuted} strokeWidth={2} />
        ) : null}
        {latestCallLabel ? (
          <Text style={[styles.headerLatest, type.meta]} numberOfLines={1}>
            {latestCallLabel}
          </Text>
        ) : null}
      </Pressable>
      {open ? (
        <ToolRunMembers
          followKey={blocks.length + asideCount}
          startsAtEnd={live}
          memoryKey={runKey}
        >
          <ToolRunMemberList
            blocks={blocks}
            previousTodoWrite={previousTodoWrite}
            previousUpdatePlan={previousUpdatePlan}
            expandChildren={expandChildren}
            disclosureId={disclosureId}
            asides={asides}
            fontScale={fontScale}
            onOpenFile={onOpenFile}
          />
        </ToolRunMembers>
      ) : null}
    </View>
  )
}

/** Desktop parity: `NativeChatToolRunMemberList`. Mounted only while the run is open,
 *  so a collapsed run pays for none of the pairing. */
function ToolRunMemberList({
  blocks,
  disclosureId,
  asides,
  previousTodoWrite,
  previousUpdatePlan,
  expandChildren,
  fontScale,
  onOpenFile
}: {
  blocks: NativeChatBlock[]
  disclosureId?: string
  asides?: MobileNativeChatToolRunAsides
  previousTodoWrite?: NativeChatToolCallBlock
  previousUpdatePlan?: NativeChatToolCallBlock
  expandChildren: boolean
  fontScale: number
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  const taskLists = useMemo(
    () =>
      buildNativeChatTaskListRows(blocks, {
        todowrite: previousTodoWrite,
        update_plan: previousUpdatePlan
      }),
    [blocks, previousTodoWrite, previousUpdatePlan]
  )
  const { editCards, consumedResults } = useMemo(() => buildEditCards(blocks), [blocks])
  const { resultByCall, pairedResults } = useMemo(() => pairNativeChatToolResults(blocks), [blocks])
  const seen = new Map<string, number>()
  const member = (block: NativeChatBlock, blockIndex: number): React.ReactNode => {
    const taskList = taskLists.rows.get(block)
    if (taskList) {
      return (
        <MobileNativeChatTaskList key={`tasks:${blockIndex}`} {...taskList} fontScale={fontScale} />
      )
    }
    const edit = editCards.get(block)
    if (edit) {
      return (
        <View key={`edit:${edit.key}`}>
          {edit.files.map((file, fileIndex) => (
            <MobileNativeChatDiffCard
              key={`${edit.key}:${fileIndex}`}
              file={file}
              defaultExpanded={expandChildren}
              disclosureKey={
                disclosureId === undefined
                  ? undefined
                  : `diff:${disclosureId}:${expandChildren}:${edit.key}:${fileIndex}`
              }
              fontScale={fontScale}
              onOpenFile={onOpenFile}
            />
          ))}
        </View>
      )
    }
    // A result its call now owns is drawn by that call's line, not as a row of its own.
    if (
      taskLists.consumedResults.has(block) ||
      consumedResults.has(block) ||
      pairedResults.has(block) ||
      (block.type !== 'tool-call' && block.type !== 'tool-result')
    ) {
      return null
    }
    const lineIdentity = nativeChatToolLineIdentity(block, seen, true)
    return (
      <MobileNativeChatToolLine
        key={lineIdentity}
        block={block}
        result={block.type === 'tool-call' ? resultByCall.get(block) : undefined}
        defaultExpanded={expandChildren}
        disclosureKey={
          disclosureId === undefined
            ? undefined
            : `line:${disclosureId}:${expandChildren}:${lineIdentity}`
        }
        fontScale={fontScale}
        onOpenFile={onOpenFile}
      />
    )
  }

  return (
    <>
      {/* One flat keyed list with or without asides, so a row gaining its first never remounts a line. */}
      {blocks.flatMap((block, blockIndex) => [
        ...(asides?.before.get(block) ?? []),
        member(block, blockIndex)
      ])}
      {asides?.after}
    </>
  )
}
