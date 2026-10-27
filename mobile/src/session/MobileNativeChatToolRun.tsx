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
  Platform,
  type ScrollView,
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
} from '../../../src/shared/native-chat/tools/native-chat-tool-activity'
import { nativeChatToolRunIconName } from '../../../src/shared/native-chat/tools/native-chat-tool-icon'
import { nativeChatToolLineIdentity } from '../../../src/shared/native-chat/tools/native-chat-tool-line-identity'
import { pairNativeChatToolResults } from '../../../src/shared/native-chat/tools/native-chat-tool-pairing'
import { nativeChatToolRunOutcome } from '../../../src/shared/native-chat/tools/native-chat-tool-run-outcome'
import {
  NATIVE_CHAT_TOOL_RUN_SENTENCE_ENGLISH,
  nativeChatToolRunSentence
} from '../../../src/shared/native-chat/tools/native-chat-tool-run-sentence'
import { countToolCalls } from '../../../src/shared/native-chat/tools/native-chat-tool-summary'
import { buildEditCards } from '../../../src/shared/native-chat/tools/native-chat-edit-cards'
import {
  isToolCallBlock,
  type NativeChatBlock,
  type NativeChatToolCallBlock
} from '../../../src/shared/native-chat-types'
import { buildNativeChatTaskListRows } from '../../../src/shared/native-chat/input/native-chat-task-list-history'
import { colors } from '../theme/mobile-theme'
import { MobileNativeChatToolGlyph } from './MobileNativeChatToolIcon'
import { MobileNativeChatToolLine } from './MobileNativeChatToolLine'
import { MobileNativeChatDiffCard } from './MobileNativeChatDiffCard'
import { MobileNativeChatTaskList } from './native-chat/input/MobileNativeChatTaskList'
import { MobileNativeChatOpenedDetailContext } from './mobile-native-chat-opened-detail'
import {
  MAX_DISCLOSURES,
  MobileNativeChatDisclosureContext,
  useMobileNativeChatDisclosure
} from './mobile-native-chat-disclosure-store'
import { toolStyles as styles, toolType } from './mobile-native-chat-tool-styles'
import { mobileNativeChatMemberId } from './mobile-native-chat-reading-place'
import { MobileNativeChatOwnedScrollView } from './MobileNativeChatOwnedScrollView'
import type {
  MobileNativeChatToolRunAsides,
  MobileNativeChatToolRunProps
} from './mobile-native-chat-tool-run-props'
export type { MobileNativeChatToolRunAsides } from './mobile-native-chat-tool-run-props'

/** Desktop's 18rem: an opened run lists this much before it scrolls in place. */
const MEMBERS_MIN_HEIGHT = 288
const FOLLOW_REARM_PX = 24

function fill(template: string, value: number): string {
  return template.replaceAll('{{value0}}', String(value))
}

// Keep one header element so live-to-settled changes cannot remount it.
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

function ToolRunMembers({
  followKey,
  startsAtEnd,
  memoryKey,
  owner,
  children
}: {
  // Follow only new work, not a reader opening existing detail.
  followKey: number
  startsAtEnd: boolean
  memoryKey?: string
  owner?: string
  children: React.ReactNode
}): React.JSX.Element {
  const { height } = useWindowDimensions()
  const store = useContext(MobileNativeChatDisclosureContext)
  const runScroll = store?.runScroll
  const owned = Platform.OS === 'web' && store !== null
  const [remembered] = useState(() =>
    memoryKey === undefined ? undefined : runScroll?.get(memoryKey)
  )
  const scroller = useRef<ScrollView>(null)
  const followsEnd = useRef(remembered?.followsEnd ?? startsAtEnd)
  const pendingRestore = useRef(remembered !== undefined && !remembered.followsEnd)
  // Decide follow in the work update so later detail expansion cannot inherit it.
  useLayoutEffect(() => {
    if (!owned && followsEnd.current) {
      scroller.current?.scrollToEnd({ animated: false })
    }
  }, [followKey, owned])
  const details = useRef(new Map<string, number>())
  const [openedHeight, setOpenedHeight] = useState(0)
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
    if (!owned && runScroll && memoryKey !== undefined) {
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
  // Restore the saved offset only after content layout exists.
  const onContentSizeChange = () => {
    if (!owned && pendingRestore.current && remembered) {
      pendingRestore.current = false
      scroller.current?.scrollTo({ y: remembered.top, animated: false })
    }
  }
  return (
    <MobileNativeChatOpenedDetailContext.Provider value={reportDetail}>
      <MobileNativeChatOwnedScrollView
        positionKey={memoryKey ?? `run:${owner ?? 'local'}`}
        rootIdentity={`run:${owner ?? 'local'}`}
        owner={owner}
        initialFollow={startsAtEnd}
        followKey={followKey}
        ref={scroller}
        style={[
          styles.members,
          { maxHeight: Math.min(height / 2, MEMBERS_MIN_HEIGHT + openedHeight) }
        ]}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={32}
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
      >
        {children}
      </MobileNativeChatOwnedScrollView>
    </MobileNativeChatOpenedDetailContext.Provider>
  )
}

export function ToolRun({
  blocks,
  disclosureId,
  asides,
  activeTurnIsWorking,
  trailing,
  awaitingAnswer = false,
  previousTodoWrite,
  previousUpdatePlan,
  fontScale = 1,
  onOpenFile
}: MobileNativeChatToolRunProps): React.JSX.Element {
  const runKey = disclosureId === undefined ? undefined : `run:${disclosureId}`
  const [open, setOpen] = useMobileNativeChatDisclosure(runKey, false)
  const asideCount = asides
    ? asides.after.length +
      Array.from(asides.before.values()).reduce((count, rows) => count + rows.length, 0)
    : 0
  // Use turn liveness; individual calls settling must not flicker the header between live and settled.
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
    <View style={styles.run} testID={mobileNativeChatMemberId('run')}>
      {/* Keep one button through live/settled states so accessibility focus survives. */}
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
          <Text style={[styles.lineMeta, styles.headerMarks, type.meta]} numberOfLines={1}>
            {` · ${marks.join(', ')}`}
          </Text>
        ) : null}
        {}
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
          owner={disclosureId}
        >
          <ToolRunMemberList
            blocks={blocks}
            previousTodoWrite={previousTodoWrite}
            previousUpdatePlan={previousUpdatePlan}
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

// Mount pairing only while open so collapsed runs avoid its work.
function ToolRunMemberList({
  blocks,
  disclosureId,
  asides,
  previousTodoWrite,
  previousUpdatePlan,
  fontScale,
  onOpenFile
}: {
  blocks: NativeChatBlock[]
  disclosureId?: string
  asides?: MobileNativeChatToolRunAsides
  previousTodoWrite?: NativeChatToolCallBlock
  previousUpdatePlan?: NativeChatToolCallBlock
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
  // Stable member keys preserve reading position and card state when older calls join above.
  const memberSeen = new Map<string, number>()
  const memberIdentity = (block: NativeChatBlock) =>
    nativeChatToolLineIdentity(block, memberSeen, true)
  const member = (block: NativeChatBlock): React.ReactNode => {
    const taskList = taskLists.rows.get(block)
    if (taskList) {
      const id = memberIdentity(block)
      return (
        <View key={`tasks:${id}`} testID={mobileNativeChatMemberId(id)}>
          <MobileNativeChatTaskList
            {...taskList}
            fontScale={fontScale}
            disclosureKey={disclosureId === undefined ? undefined : `tasks:${disclosureId}:${id}`}
          />
        </View>
      )
    }
    const edit = editCards.get(block)
    if (edit) {
      const id = memberIdentity(block)
      return (
        <View key={`edit:${id}`} testID={mobileNativeChatMemberId(id)}>
          {edit.files.map((file, fileIndex) => (
            <MobileNativeChatDiffCard
              key={`${id}:${fileIndex}`}
              file={file}
              rootIdentity={`diff:${id}:${fileIndex}`}
              disclosureKey={
                disclosureId === undefined ? undefined : `diff:${disclosureId}:${id}:${fileIndex}`
              }
              fontScale={fontScale}
              onOpenFile={onOpenFile}
            />
          ))}
        </View>
      )
    }
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
        memberId={mobileNativeChatMemberId(memberIdentity(block))}
        block={block}
        result={block.type === 'tool-call' ? resultByCall.get(block) : undefined}
        disclosureKey={
          disclosureId === undefined ? undefined : `line:${disclosureId}:${lineIdentity}`
        }
        fontScale={fontScale}
        onOpenFile={onOpenFile}
      />
    )
  }

  return (
    <>
      {/* Keep one keyed list so adding the first aside cannot remount tool lines. */}
      {blocks.flatMap((block) => [...(asides?.before.get(block) ?? []), member(block)])}
      {asides?.after}
    </>
  )
}
