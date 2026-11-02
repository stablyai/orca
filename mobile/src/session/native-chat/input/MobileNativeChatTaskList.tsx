import { Pressable, Text, View } from 'react-native'
import { Ban, ChevronRight, Circle, CircleCheck, CircleDot, ListChecks } from 'lucide-react-native'
import {
  diffNativeChatTaskLists,
  nativeChatCompletedTaskCount,
  nativeChatTaskChangeWords,
  nativeChatTaskLabel,
  type NativeChatTask,
  type NativeChatTaskList as TaskList
} from '../../../../../src/shared/native-chat/input/native-chat-task-list'
import { nativeChatTaskListCopy } from './native-chat-task-list-copy'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { ListGroup } from '../../../components/list/ListGroup'
import { colors, pressedStyle, spacing } from '../../../theme/mobile-theme'
import { useMobileNativeChatOpenedDetail } from '../visual/mobile-native-chat-opened-detail'
import { toolStyles as styles, toolType } from '../transcript/mobile-native-chat-tool-styles'
import { useMobileNativeChatDisclosure } from '../transcript/mobile-native-chat-disclosure-store'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'

const groupedTaskRow = {
  paddingHorizontal: spacing.md,
  paddingVertical: spacing.sm + 2
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
  fontScale,
  grouped = false
}: {
  task: NativeChatTask
  label?: string
  fontScale: number
  grouped?: boolean
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const copy = nativeChatTaskListCopy(t)
  const statusWord: Record<NativeChatTask['status'], string> = {
    completed: copy.completed,
    in_progress: copy.inProgress,
    pending: copy.pending,
    cancelled: copy.cancelled
  }
  const Icon =
    task.status === 'completed'
      ? CircleCheck
      : task.status === 'in_progress'
        ? CircleDot
        : task.status === 'cancelled'
          ? Ban
          : Circle
  const active = task.status === 'in_progress'
  return (
    <View
      style={[styles.taskRow, grouped && groupedTaskRow]}
      accessibilityLabel={t('chat.taskList.taskStatus', '{{status}}: {{task}}', {
        status: statusWord[task.status],
        task: label ?? nativeChatTaskLabel(task)
      })}
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
          !label && (task.status === 'completed' || task.status === 'cancelled') && styles.struck
        ]}
      >
        {label ?? nativeChatTaskLabel(task)}
      </Text>
    </View>
  )
}

function Checklist({ list, fontScale }: { list: TaskList; fontScale: number }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return list.tasks.length === 0 ? (
    <Text style={[styles.lineMeta, toolType(fontScale).meta]}>
      {nativeChatTaskListCopy(t).empty}
    </Text>
  ) : (
    <View style={styles.taskList}>
      {occurrenceKeyed(list.tasks, (task) => task.content).map(([task, key]) => (
        <TaskRow key={key} task={task} fontScale={fontScale} />
      ))}
    </View>
  )
}

function FullList({
  list,
  fontScale,
  disclosureKey
}: {
  list: TaskList
  fontScale: number
  disclosureKey?: string
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [open, setOpen] = useMobileNativeChatDisclosure(disclosureKey, false)
  return (
    <View>
      <Pressable
        style={({ pressed }) => [styles.taskDisclosure, pressed && pressedStyle]}
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <View style={open ? styles.caretOpen : undefined}>
          <ChevronRight size={14 * fontScale} color={colors.textMuted} strokeWidth={2} />
        </View>
        <Text style={[styles.lineMeta, toolType(fontScale).meta]}>
          {nativeChatTaskListCopy(t).showAll}
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

export function MobileNativeChatTaskList({
  list,
  previous,
  fontScale,
  disclosureKey,
  variant = 'card'
}: {
  list: TaskList
  previous?: TaskList
  fontScale: number
  disclosureKey?: string
  /** `sheet` is the current list inside the tasks drawer. `card` is the inline transcript diff. */
  variant?: 'card' | 'sheet'
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const completed = nativeChatCompletedTaskCount(list)
  const copy = nativeChatTaskListCopy(t, { completed, total: list.tasks.length })
  if (variant === 'sheet') {
    return (
      <>
        <ListGroup>
          {list.tasks.length === 0 ? (
            <Text style={[styles.lineMeta, toolType(fontScale).meta, groupedTaskRow]}>
              {copy.empty}
            </Text>
          ) : (
            occurrenceKeyed(list.tasks, (task) => task.content).map(([task, key]) => (
              <TaskRow key={key} task={task} fontScale={fontScale} grouped />
            ))
          )}
        </ListGroup>
        {list.explanation ? (
          <Text style={[styles.lineMeta, toolType(fontScale).meta]}>{list.explanation}</Text>
        ) : null}
      </>
    )
  }
  const changes = previous ? diffNativeChatTaskLists(previous, list) : null
  const type = toolType(fontScale)
  return (
    <View style={styles.taskCard}>
      <View style={styles.taskHeader} accessibilityLabel={copy.progress}>
        <ListChecks size={15 * fontScale} color={colors.textMuted} strokeWidth={2} />
        <Text style={[styles.lineMeta, styles.taskTitle, type.meta]}>{copy.title}</Text>
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
                      label={nativeChatTaskListCopy(t, { task })[key]}
                      fontScale={fontScale}
                    />
                  )
                }
              )}
            </View>
          ) : (
            <Text style={[styles.lineMeta, type.meta]}>{copy.unchanged}</Text>
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
