/** @jsxImportSource orca */
import {
  atom,
  Badge,
  Button,
  derived,
  EmptyState,
  Heading,
  IconButton,
  Input,
  List,
  ListItem,
  on,
  read,
  Row,
  set,
  Stack,
  Switch,
  Text,
  update,
  type PanelContext
} from 'orca'

type Todo = { id: number; title: string; done: boolean }

// Persisted for the plugin: the list survives closing the panel and restarting Orca.
const todos = atom<Todo[]>(
  'todos',
  [
    { id: 1, title: 'Read the components guide', done: true },
    { id: 2, title: 'Build a panel', done: false }
  ],
  { persist: 'plugin' }
)
const hideDone = atom('hide-done', false, { persist: 'plugin' })
const draft = atom('')
const open = derived(() => read(todos).filter((todo) => !todo.done).length)

function add(): void {
  const title = read(draft).trim()
  if (!title) {
    return
  }
  update(todos, (list) => [
    ...list,
    { id: Math.max(0, ...list.map((t) => t.id)) + 1, title, done: false }
  ])
  set(draft, '')
}

function toggle(id: number): void {
  update(todos, (list) =>
    list.map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo))
  )
}

function TodoList({ items }: { items: Todo[] }) {
  if (items.length === 0) {
    return <EmptyState icon="check" title="Nothing to do" description="Add a task above." />
  }
  return (
    <List label="Tasks">
      {items.map((todo) => (
        <ListItem
          key={String(todo.id)}
          icon={todo.done ? 'check' : 'stop'}
          title={todo.title}
          description={todo.done ? 'Done' : 'Open'}
          onPress={() => toggle(todo.id)}
        />
      ))}
    </List>
  )
}

const seenThemes = atom(0)

/** Optional: runs once before the first render; its subscriptions end when the panel closes. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(on('theme', () => update(seenThemes, (n) => n + 1)))
}

export default function Panel() {
  const all = read(todos)
  const items = read(hideDone) ? all.filter((todo) => !todo.done) : all
  const count = read(open)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Tasks</Heading>
        <Badge tone={count > 0 ? 'accent' : 'neutral'}>{count} open</Badge>
      </Row>
      <Row gap="xs">
        <Input
          label="New task"
          labelHidden
          placeholder="New task"
          value={read(draft)}
          onChange={(value) => set(draft, value)}
          onSubmit={add}
        />
        <IconButton icon="add" label="Add task" onPress={add} disabled={!read(draft).trim()} />
      </Row>
      <Switch
        label="Hide done"
        checked={read(hideDone)}
        onChange={(value) => set(hideDone, value)}
      />
      <TodoList items={items} />
      <Row justify="end">
        <Button
          variant="ghost"
          onPress={() => update(todos, (list) => list.filter((todo) => !todo.done))}
        >
          Clear done
        </Button>
      </Row>
      <Text muted size="xs">
        Runs isolated with no network; Orca draws every control. Theme changes seen:{' '}
        {read(seenThemes)}.
      </Text>
    </Stack>
  )
}
