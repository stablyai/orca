import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { Pressable, Text } from 'react-native'
import {
  agentSessionForegroundTaskKey,
  type AgentSessionForegroundTask
} from '../../../../../src/shared/agent-session/agent-session-foreground-task'
import type { MobileStructuredBackgroundTasks } from '../../use-mobile-structured-background-tasks'
import { colors, spacing, typography, pressedStyle, radii } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'

type Actions = {
  tasks: readonly AgentSessionForegroundTask[]
  pending: ReadonlySet<string>
  run: (task: AgentSessionForegroundTask) => void
}
const Context = createContext<Actions | null>(null)

export function MobileNativeChatForegroundTasksProvider(props: {
  tasks: MobileStructuredBackgroundTasks | null
  children: ReactNode
}) {
  const inFlight = useRef(new Set<string>())
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const background = props.tasks?.background
  const run = useCallback(
    (task: AgentSessionForegroundTask) => {
      const key = agentSessionForegroundTaskKey(task)
      if (inFlight.current.has(key) || !background) {
        return
      }
      inFlight.current.add(key)
      setPending(new Set(inFlight.current))
      void background(task)
        .then((ok) => {
          if (!ok) {
            inFlight.current.delete(key)
          }
        })
        .catch(() => inFlight.current.delete(key))
        .finally(() => setPending(new Set(inFlight.current)))
    },
    [background]
  )
  const tasks =
    props.tasks?.rowContext.transportObservation === 'live'
      ? props.tasks.view.foregroundTasks
      : undefined
  const value = useMemo(
    () => ({
      tasks: tasks ?? [],
      pending,
      run
    }),
    [tasks, pending, run]
  )
  return <Context value={value}>{props.children}</Context>
}

export function MobileNativeChatForegroundTaskAction(props: {
  toolUseId?: string
  taskId?: string
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const actions = useContext(Context)
  const task = actions?.tasks.find(
    (candidate) =>
      (props.toolUseId !== undefined && candidate.toolUseId === props.toolUseId) ||
      (props.taskId !== undefined && candidate.taskId === props.taskId)
  )
  if (!actions || !task) {
    return null
  }
  const pending = actions.pending.has(agentSessionForegroundTaskKey(task))
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: pending }}
      disabled={pending}
      style={({ pressed }) => [styles.action, pressed && pressedStyle]}
      onPress={() => actions.run(task)}
    >
      <Text style={styles.label}>
        {pending
          ? t('session.backgroundTask.backgrounding', 'Backgrounding…')
          : t('session.backgroundTask.background', 'Background')}
      </Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  action: {
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    justifyContent: 'center',
    borderRadius: radii.control
  },
  label: { color: colors.textPrimary, fontSize: typography.metaSize, fontWeight: '500' }
}))
