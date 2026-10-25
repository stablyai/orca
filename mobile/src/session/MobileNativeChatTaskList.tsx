import { Pressable, Text, View } from 'react-native'
import { ChevronRight, Circle, CircleCheck, CircleDot, ListChecks } from 'lucide-react-native'
import {
  diffNativeChatTaskLists,
  NATIVE_CHAT_TASK_LIST_COPY,
  nativeChatTaskChangeWords,
  nativeChatTaskLabel,
  type NativeChatTask,
  type NativeChatTaskList as TaskList
} from '../../../src/shared/native-chat-task-list'
import { colors } from '../theme/mobile-theme'
import { useMobileNativeChatOpenedDetail } from './mobile-native-chat-opened-detail'
import { toolStyles as styles, toolType } from './mobile-native-chat-tool-styles'
import { useMobileNativeChatDisclosure } from './mobile-native-chat-disclosure-store'

const STATUS_WORD: Record<NativeChatTask['status'], string> = {
  completed: NATIVE_CHAT_TASK_LIST_COPY.completed,
  in_progress: NATIVE_CHAT_TASK_LIST_COPY.inProgress,
  pending: NATIVE_CHAT_TASK_LIST_COPY.pending
}

/** Content plus occurrence is the only identity the providers give these entries. */
function occurrenceKeyed<T>(items: readonly T[], content: (item: T) => string): [T, string][] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const signature = content(item)
    const occurrence = seen.get(signature) ?? 0
    seen.set(signature, occurrence + 1)
    return [item, `${signature}:${occurrence}`]
  })
}

function TaskRow({
  task,
  label,
  fontScale
}: {
  task: NativeChatTask
  label?: string
  fontScale: number
}): React.JSX.Element {
  const Icon =
    task.status === 'completed' ? CircleCheck : task.status === 'in_progress' ? CircleDot : Circle
  const active = task.status === 'in_progress'
  return (
    <View
      style={styles.taskRow}
      accessibilityLabel={`${STATUS_WORD[task.status]}: ${label ?? nativeChatTaskLabel(task)}`}
    >
      <View style={[styles.taskIcon, { height: toolType(fontScale).row.lineHeight }]}>
        <Icon
          size={14 * fontScale}
          color={active ? colors.textPrimary : colors.textMuted}
          strokeWidth={2}
        />
      </View>
      <Text
        style={[
          styles.taskText,
          toolType(fontScale).row,
          active && styles.taskActive,
          !label && task.status === 'completed' && styles.struck
        ]}
      >
        {label ?? nativeChatTaskLabel(task)}
      </Text>
    </View>
  )
}

function Checklist({ list, fontScale }: { list: TaskList; fontScale: number }) {
  return list.tasks.length === 0 ? (
    <Text style={[styles.lineMeta, toolType(fontScale).meta]}>
      {NATIVE_CHAT_TASK_LIST_COPY.empty}
    </Text>
  ) : (
    <View style={styles.taskList}>
      {occurrenceKeyed(list.tasks, (task) => task.content).map(([task, key]) => (
        <TaskRow key={key} task={task} fontScale={fontScale} />
      ))}
    </View>
  )
}

/** The whole list behind a disclosure, under a list of what changed. */
function FullList({
  list,
  fontScale,
  disclosureKey
}: {
  list: TaskList
  fontScale: number
  disclosureKey?: string
}) {
  const [open, setOpen] = useMobileNativeChatDisclosure(disclosureKey, false)
  return (
    <View>
      <Pressable
        style={styles.taskDisclosure}
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <View style={open ? styles.caretOpen : undefined}>
          <ChevronRight size={14 * fontScale} color={colors.textMuted} strokeWidth={2} />
        </View>
        <Text style={[styles.lineMeta, toolType(fontScale).meta]}>
          {NATIVE_CHAT_TASK_LIST_COPY.showAll}
        </Text>
      </Pressable>
      {open ? <OpenedChecklist list={list} fontScale={fontScale} /> : null}
    </View>
  )
}

function OpenedChecklist({ list, fontScale }: { list: TaskList; fontScale: number }) {
  const onLayout = useMobileNativeChatOpenedDetail()
  return (
    <View onLayout={onLayout}>
      <Checklist list={list} fontScale={fontScale} />
    </View>
  )
}

/** Desktop parity: `NativeChatTaskList`, inline. A plan update reads as what it
 *  changed against the previous list, or as the whole checklist when it is the first. */
export function MobileNativeChatTaskList({
  list,
  previous,
  fontScale,
  disclosureKey
}: {
  list: TaskList
  previous?: TaskList
  fontScale: number
  disclosureKey?: string
}): React.JSX.Element {
  const completed = list.tasks.filter((task) => task.status === 'completed').length
  const changes = previous ? diffNativeChatTaskLists(previous, list) : null
  const type = toolType(fontScale)
  return (
    <View style={styles.taskCard}>
      <View
        style={styles.taskHeader}
        accessibilityLabel={NATIVE_CHAT_TASK_LIST_COPY.progress
          .replace('{{completed}}', String(completed))
          .replace('{{total}}', String(list.tasks.length))}
      >
        <ListChecks size={15 * fontScale} color={colors.textMuted} strokeWidth={2} />
        <Text style={[styles.lineMeta, styles.taskTitle, type.meta]}>
          {NATIVE_CHAT_TASK_LIST_COPY.title}
        </Text>
        <Text style={[styles.lineMeta, type.meta]}>{`${completed}/${list.tasks.length}`}</Text>
      </View>
      {changes ? (
        <>
          {changes.length > 0 ? (
            <View style={styles.taskList}>
              {occurrenceKeyed(changes, (change) => `${change.kind}:${change.task.content}`).map(
                ([change, rowKey]) => {
                  const { key, task } = nativeChatTaskChangeWords(change)
                  return (
                    <TaskRow
                      key={rowKey}
                      task={change.task}
                      label={NATIVE_CHAT_TASK_LIST_COPY[key].replace('{{task}}', task)}
                      fontScale={fontScale}
                    />
                  )
                }
              )}
            </View>
          ) : (
            <Text style={[styles.lineMeta, type.meta]}>{NATIVE_CHAT_TASK_LIST_COPY.unchanged}</Text>
          )}
          <FullList list={list} fontScale={fontScale} disclosureKey={disclosureKey} />
        </>
      ) : (
        <Checklist list={list} fontScale={fontScale} />
      )}
      {list.explanation ? (
        <Text style={[styles.lineMeta, type.meta]}>{list.explanation}</Text>
      ) : null}
    </View>
  )
}
